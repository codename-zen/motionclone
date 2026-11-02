import { fillSamples } from "./fill.ts";
import { type Plane, readLuma } from "./luma.ts";
import { type Frame, pyramid, type Rect } from "./match.ts";
import { TemplateModel } from "./model.ts";
import {
	judge,
	MIN_SHAPE_CONTRAST,
	measureNoise,
	type Status,
} from "./quality.ts";
import { type NamedRect, pickRef, tighten } from "./regions.ts";
import {
	changeStats,
	type RegionSample,
	type RegionTrack,
	sampleBox,
} from "./samples.ts";
import {
	clampScale,
	type Lock,
	MAX_BLUR,
	type Pose,
	place,
	search,
} from "./search.ts";

// Within these the element does not scale or blur (h264 noise), and the region is tracked again with them fixed.
const SCALE_NOISE = 0.01;
/** Blurs under one reference-frame pixel are noise. */
export const MIN_BLUR = 1;
// Consecutive frames read at each end to estimate compression noise.
const NOISE_FRAMES = 4;
// Context ring around the element so a flat-coloured element still has edges to match.
const MARGIN = 6;

export interface TrackRegionInput extends NamedRect {
	ref: "auto" | "first" | "last";
}

const expand = (r: Rect, m: number, p: Plane): Rect => {
	const x = Math.max(0, r.x - m);
	const y = Math.max(0, r.y - m);
	return {
		x,
		y,
		w: Math.min(p.width, r.x + r.w + m) - x,
		h: Math.min(p.height, r.y + r.h + m) - y,
	};
};

interface State {
	region: RegionTrack;
	model: TemplateModel;
	/** Box centre in the reference frame, and its offset from the window centre that scales with the element. */
	home: { x: number; y: number };
	offset: { x: number; y: number };
	pose: Pose;
	vel: Pose;
	prevFound: boolean;
	lock: Lock;
	noise: number;
}

const isFound = (st: Status) => st === "found" || st === "faint";

const still: Pose = { cx: 0, cy: 0, s: 0, blur: 0 };

const shiftOf = (s: State, p: Pose) => ({
	dx: p.cx + p.s * s.offset.x - s.home.x,
	dy: p.cy + p.s * s.offset.y - s.home.y,
});

function step(s: State, f: Frame, k: number) {
	const pred: Pose = {
		cx: s.pose.cx + s.vel.cx,
		cy: s.pose.cy + s.vel.cy,
		s: clampScale(s.pose.s * Math.exp(s.vel.s)),
		blur: Math.min(MAX_BLUR, Math.max(0, s.pose.blur + s.vel.blur)),
	};
	let m = search(f, s.model, pred, s.lock);
	if (m.contrast < MIN_SHAPE_CONTRAST)
		m = place(f, s.model, { ...m, s: s.pose.s, blur: s.pose.blur });
	let j = judge(m, s.noise);
	if (!isFound(j.status)) {
		// The search may have strayed onto nearby content: judge what is at the expected place instead.
		m = place(f, s.model, { ...pred, s: s.pose.s, blur: s.pose.blur });
		j = judge(m, s.noise);
	}
	const { status, quality } = j;
	const found = isFound(status);
	Object.assign(s.region.samples[k] as RegionSample, {
		found,
		...shiftOf(s, m),
		scale: m.s,
		blur: m.blur,
		ncc: m.ncc,
		opacity: found ? Math.min(1, Math.max(0, m.contrast)) : 0,
		quality: Math.round(quality * 1000) / 1000,
		status,
	});
	if (found) {
		const shaped = status === "found";
		const next: Pose = {
			cx: m.cx,
			cy: m.cy,
			s: shaped ? m.s : s.pose.s,
			blur: shaped ? m.blur : s.pose.blur,
		};
		s.vel = s.prevFound
			? {
					cx: next.cx - s.pose.cx,
					cy: next.cy - s.pose.cy,
					s: Math.log(next.s / s.pose.s),
					blur: next.blur - s.pose.blur,
				}
			: still;
		s.pose = next;
	} else s.vel = still;
	s.prevFound = found;
}

function initState(
	r: TrackRegionInput,
	frames: number,
	first: Plane,
	last: Plane,
	ends: Ends,
	floor: number,
	lock: Lock,
): State {
	const box = tighten(first, last, r, floor);
	const win = expand(box, MARGIN, first);
	const ref = r.ref === "auto" ? pickRef(first, last, win) : r.ref;
	const samples: RegionSample[] = Array.from({ length: frames }, () => ({
		found: false,
		dx: 0,
		dy: 0,
		scale: 1,
		blur: 0,
		ncc: 0,
		opacity: 0,
		quality: 0,
		status: "absent",
		centroid: null,
		energy: 0,
	}));
	const home = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
	const centre = { x: win.x + win.w / 2, y: win.y + win.h / 2 };
	return {
		region: { name: r.name, box, ref, samples },
		model: new TemplateModel(ends.frames[ref], win),
		home,
		offset: { x: home.x - centre.x, y: home.y - centre.y },
		pose: { cx: centre.x, cy: centre.y, s: 1, blur: 0 },
		vel: still,
		prevFound: false,
		lock,
		noise: measureNoise(ends.near[ref], win, floor),
	};
}

const shapedOf = (smp: RegionSample[]) => smp.map((p) => p.status === "found");

/** Fix scale or blur when they never leave their noise band, so that noise cannot leak into the position. */
function lockOf(smp: RegionSample[]): Lock {
	const clear = smp.filter((_, k) => shapedOf(smp)[k]);
	return {
		scale: clear.every((p) => Math.abs(Math.log(p.scale)) < SCALE_NOISE),
		blur: clear.every((p) => p.blur < MIN_BLUR),
	};
}

interface Ends {
	first: Plane;
	last: Plane;
	frames: { first: Frame; last: Frame };
	/** A few consecutive frames at each end, for the noise estimate. */
	near: { first: Plane[]; last: Plane[] };
}

/** Each state from its reference end of the clip towards the other end. */
async function runPass(
	dir: string,
	frames: number,
	states: State[],
	ends: Ends,
	floor: number,
) {
	for (const ref of ["first", "last"] as const) {
		const group = states.filter((s) => s.region.ref === ref);
		if (group.length === 0) continue;
		const order = Array.from({ length: frames }, (_, i) =>
			ref === "first" ? i : frames - 1 - i,
		);
		let prev: { k: number; plane: Plane } | null = null;
		for (const k of order) {
			const plane =
				k === 0
					? ends.first
					: k === frames - 1
						? ends.last
						: await readLuma(dir, k);
			const f: Frame =
				k === 0
					? ends.frames.first
					: k === frames - 1
						? ends.frames.last
						: pyramid(plane);
			for (const s of group) {
				step(s, f, k);
				const box = sampleBox(s.region.box, {
					...(s.region.samples[k] as RegionSample),
					...shiftOf(s, s.pose),
					scale: s.pose.s,
				});
				(s.region.samples[k] as RegionSample).centroid = changeStats(
					plane,
					ends.first,
					box,
					floor,
				).centroid;
				if (prev) {
					const [later, earlier] =
						prev.k > k ? [prev, plane] : [{ k, plane }, prev.plane];
					const ls = s.region.samples[later.k] as RegionSample;
					ls.energy = changeStats(
						later.plane,
						earlier,
						sampleBox(s.region.box, ls),
						floor,
					).mean;
				}
			}
			prev = { k, plane };
		}
	}
}

/**
 * Track each region with scale and blur free; regions where either stays within noise
 * are tracked again with it fixed.
 */
export async function trackRegions(
	dir: string,
	frames: number,
	regions: TrackRegionInput[],
	planes: { first: Plane; last: Plane },
	floor: number,
	warnings: string[],
): Promise<RegionTrack[]> {
	const { first, last } = planes;
	const n = Math.min(NOISE_FRAMES, frames);
	const read = (ks: number[]) => Promise.all(ks.map((k) => readLuma(dir, k)));
	const ends: Ends = {
		first,
		last,
		frames: { first: pyramid(first), last: pyramid(last) },
		near: {
			first: await read([...Array(n).keys()]),
			last: await read([...Array(n).keys()].map((i) => frames - n + i)),
		},
	};
	const init = (r: TrackRegionInput, lock: Lock) =>
		initState(r, frames, first, last, ends, floor, lock);
	const free = { scale: false, blur: false };
	const states = regions.map((r) => init(r, free));
	await runPass(dir, frames, states, ends, floor);
	const again = new Map<number, State>();
	states.forEach((s, i) => {
		const lock = lockOf(s.region.samples);
		if (lock.scale || lock.blur)
			again.set(i, init(regions[i] as TrackRegionInput, lock));
	});
	await runPass(dir, frames, [...again.values()], ends, floor);
	for (const [i, s] of again) states[i] = s;
	for (const s of states) {
		if (!s.region.samples.some((p) => p.found))
			warnings.push(
				`region ${s.region.name}: the element was never found; its box stays at the region`,
			);
		fillSamples(s.region.samples, shapedOf(s.region.samples));
	}
	return states.map((s) => s.region);
}
