import { fillSamples } from "./fill.ts";
import { type Plane, readFrame, readLuma } from "./luma.ts";
import { pyramid } from "./match.ts";
import { mergeEnds, rebase } from "./merge.ts";
import { runPass } from "./pass.ts";
import type { RegionSample, RegionTrack } from "./samples.ts";
import type { Lock } from "./search.ts";
import {
	autoRef,
	type End,
	type Ends,
	initState,
	type State,
	type TrackRegionInput,
} from "./state.ts";

export type { TrackRegionInput } from "./state.ts";

// Within these the element does not scale or blur (h264 noise), and the region is tracked again with them fixed.
const SCALE_NOISE = 0.01;
/** Blurs under one reference-frame pixel are noise. */
export const MIN_BLUR = 1;
// Consecutive frames read at each end to estimate compression noise.
const NOISE_FRAMES = 4;
// The other end is tracked only when its window shows this many noise deviations of structure.
const MIN_STRUCTURE = 3;

// The other end's track stops once both tracks found this many consecutive frames, or the main track this many.
const LINK_FRAMES = 3;
const MAIN_FRAMES = 8;

/** Whether the main track already covers the frames the other end's track reached at k. */
function covered(o: State, main: State, k: number): boolean {
	const step = o.region.ref === "last" ? 1 : -1;
	const run = (n: number, both: boolean) =>
		Array.from({ length: n }, (_, i) => k + i * step).every(
			(j) =>
				main.region.samples[j]?.found === true &&
				(!both || o.region.samples[j]?.found === true),
		);
	return run(LINK_FRAMES, true) || run(MAIN_FRAMES, false);
}

const shapedOf = (smp: RegionSample[]) => smp.map((p) => p.status === "found");
const foundCount = (s: State) => s.region.samples.filter((p) => p.found).length;
const opposite = (e: End): End => (e === "first" ? "last" : "first");

/** Fix scale or blur when they never leave their noise band, so that noise cannot leak into the position. */
function lockOf(smp: RegionSample[]): Lock {
	const clear = smp.filter((_, k) => shapedOf(smp)[k]);
	return {
		scale: clear.every((p) => Math.abs(Math.log(p.scale)) < SCALE_NOISE),
		blur: clear.every((p) => p.blur < MIN_BLUR),
	};
}

function hasStructure(s: State): boolean {
	const g = s.model.render("full", 1, 0);
	return Math.sqrt(g.sumSq / (g.w * g.h)) >= MIN_STRUCTURE * s.noise;
}

async function readEnds(
	dir: string,
	frames: number,
	first: Plane,
	last: Plane,
): Promise<Ends> {
	const n = Math.min(NOISE_FRAMES, frames);
	const read = (ks: number[]) => Promise.all(ks.map((k) => readLuma(dir, k)));
	return {
		first,
		last,
		frames: { first: pyramid(first), last: pyramid(last) },
		rgba: {
			first: (await readFrame(dir, 0)).rgba,
			last: (await readFrame(dir, frames - 1)).rgba,
		},
		near: {
			first: await read([...Array(n).keys()]),
			last: await read([...Array(n).keys()].map((i) => frames - n + i)),
		},
	};
}

/**
 * Track each region from its reference end, and from the other end when frames were lost, then merge the two.
 * When the reference is automatic, the end whose track found more frames leads.
 * Regions where scale or blur stays within noise are tracked again with it fixed.
 */
export async function trackRegions(
	dir: string,
	frames: number,
	regions: TrackRegionInput[],
	planes: { first: Plane; last: Plane },
	floor: number,
	warnings: string[],
): Promise<RegionTrack[]> {
	const ends = await readEnds(dir, frames, planes.first, planes.last);
	const free = { scale: false, blur: false };
	const init = (r: TrackRegionInput, ref: End, lock: Lock) =>
		initState(r, ref, frames, ends, floor, lock);
	const main = regions.map((r) =>
		init(r, r.ref === "auto" ? autoRef(r, ends, floor) : r.ref, free),
	);
	await runPass(dir, frames, main, ends, floor);
	const others = new Map<number, State>();
	main.forEach((s, i) => {
		if (foundCount(s) === frames) return;
		const o = init(
			regions[i] as TrackRegionInput,
			opposite(s.region.ref),
			free,
		);
		if (hasStructure(o)) others.set(i, o);
	});
	const mainOf = new Map([...others].map(([i, o]) => [o, main[i] as State]));
	await runPass(dir, frames, [...others.values()], ends, floor, (o, k) =>
		covered(o, mainOf.get(o) as State, k),
	);
	// Values stay relative to the end chosen for its structure, even when the other end's template led.
	const measuredAt = new Map<number, End>();
	for (const [i, o] of others)
		if (
			regions[i]?.ref === "auto" &&
			foundCount(o) > foundCount(main[i] as State)
		) {
			measuredAt.set(i, (main[i] as State).region.ref);
			others.set(i, main[i] as State);
			main[i] = o;
		}
	const again = new Map<number, State>();
	main.forEach((s, i) => {
		const lock = lockOf(s.region.samples);
		if (lock.scale || lock.blur)
			again.set(i, init(regions[i] as TrackRegionInput, s.region.ref, lock));
	});
	await runPass(dir, frames, [...again.values()], ends, floor);
	for (const [i, s] of again) main[i] = s;
	for (const [i, o] of others) mergeEnds((main[i] as State).region, o.region);
	for (const [i, ref] of measuredAt) rebase((main[i] as State).region, ref);
	for (const s of main) {
		const smp = s.region.samples;
		if (!smp.some((p) => p.found))
			warnings.push(
				`region ${s.region.name}: the element was never found; its box stays at the region`,
			);
		fillSamples(
			smp,
			shapedOf(smp),
			smp.map((p) => p.status === "found" && p.method !== "colour"),
		);
	}
	return main.map((s) => s.region);
}
