import { type Plane, readLuma } from "./luma.ts";
import {
	type Frame,
	locate,
	makeTemplates,
	pyramid,
	type Rect,
	type Templates,
} from "./match.ts";
import { type NamedRect, pickRef, tighten } from "./regions.ts";

// Below either value the element is treated as not visible in that frame.
export const MIN_NCC = 0.5;
export const MIN_CONTRAST = 0.05;
// Context ring around the element so a flat-coloured element still has edges to match.
const MARGIN = 6;

export interface TrackRegionInput extends NamedRect {
	ref: "auto" | "first" | "last";
}

export interface RegionSample {
	found: boolean;
	/** Shift of the element from its reference-frame box, frame pixels. */
	dx: number;
	dy: number;
	ncc: number;
	/** Opacity proxy, 0..1: contrast against the reference appearance, 0 when not found. */
	opacity: number;
	/** Centroid of change against frame 0 inside the box, frame pixels; null when nothing changed. */
	centroid: { x: number; y: number } | null;
	/** Mean absolute luma change from the previous frame inside the box. */
	energy: number;
}

export interface RegionTrack {
	name: string;
	/** Element box in the reference frame, frame pixels. */
	box: Rect;
	ref: "first" | "last";
	samples: RegionSample[];
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

function changeStats(cur: Plane, base: Plane, r: Rect, floor: number) {
	let sum = 0;
	let wsum = 0;
	let wx = 0;
	let wy = 0;
	const x0 = Math.max(0, Math.round(r.x));
	const y0 = Math.max(0, Math.round(r.y));
	const x1 = Math.min(cur.width, x0 + r.w);
	const y1 = Math.min(cur.height, y0 + r.h);
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const o = y * cur.width + x;
			const d = Math.abs((cur.data[o] as number) - (base.data[o] as number));
			sum += d;
			const w = Math.max(0, d - floor);
			wsum += w;
			wx += w * x;
			wy += w * y;
		}
	const n = Math.max(1, (x1 - x0) * (y1 - y0));
	return {
		mean: sum / n,
		centroid: wsum > 0 ? { x: wx / wsum, y: wy / wsum } : null,
	};
}

/** Fill frames where the element was not found: interpolate inside, extrapolate one frame at the edges, then hold. */
export function fillLost(v: number[], found: boolean[]): number[] {
	const out = [...v];
	const idx = found.flatMap((f, i) => (f ? [i] : []));
	if (idx.length === 0) return out.fill(0);
	for (let a = 0; a + 1 < idx.length; a++) {
		const i = idx[a] as number;
		const j = idx[a + 1] as number;
		for (let k = i + 1; k < j; k++)
			out[k] =
				(v[i] as number) +
				(((v[j] as number) - (v[i] as number)) * (k - i)) / (j - i);
	}
	const edge = (at: number, inner: number | undefined, step: number) => {
		const next = at - step;
		if (next < 0 || next >= v.length) return;
		const slope =
			inner !== undefined && found[at + step]
				? (v[at] as number) - (v[inner] as number)
				: 0;
		for (let k = next; k >= 0 && k < v.length; k -= step)
			out[k] = (v[at] as number) + slope;
	};
	const firstIdx = idx[0] as number;
	const lastIdx = idx.at(-1) as number;
	edge(firstIdx, firstIdx + 1, 1);
	edge(lastIdx, lastIdx - 1, -1);
	return out;
}

interface State {
	region: RegionTrack;
	tpl: Templates;
	pos: { dx: number; dy: number };
	vel: { dx: number; dy: number };
	prevFound: boolean;
}

/** Track each region from its reference end of the clip towards the other end. */
export async function trackRegions(
	dir: string,
	frames: number,
	regions: TrackRegionInput[],
	ends: { first: Plane; last: Plane },
	floor: number,
	warnings: string[],
): Promise<RegionTrack[]> {
	const { first, last } = ends;
	const ends$ = { first: pyramid(first), last: pyramid(last) };
	const states: State[] = regions.map((r) => {
		const box = tighten(first, last, r, floor);
		const ref =
			r.ref === "auto"
				? pickRef(first, last, expand(box, MARGIN, first))
				: r.ref;
		const samples: RegionSample[] = Array.from({ length: frames }, () => ({
			found: false,
			dx: 0,
			dy: 0,
			ncc: 0,
			opacity: 0,
			centroid: null,
			energy: 0,
		}));
		return {
			region: { name: r.name, box, ref, samples },
			tpl: makeTemplates(ends$[ref], expand(box, MARGIN, first)),
			pos: { dx: 0, dy: 0 },
			vel: { dx: 0, dy: 0 },
			prevFound: false,
		};
	});
	for (const ref of ["first", "last"] as const) {
		const group = states.filter((s) => s.region.ref === ref);
		if (group.length === 0) continue;
		const order = Array.from({ length: frames }, (_, i) =>
			ref === "first" ? i : frames - 1 - i,
		);
		let prev: { k: number; plane: Plane } | null = null;
		for (const k of order) {
			const plane =
				k === 0 ? first : k === frames - 1 ? last : await readLuma(dir, k);
			const f: Frame =
				k === 0 ? ends$.first : k === frames - 1 ? ends$.last : pyramid(plane);
			for (const s of group) {
				const pred = { dx: s.pos.dx + s.vel.dx, dy: s.pos.dy + s.vel.dy };
				const m = locate(f, s.tpl, pred);
				const found = m.ncc >= MIN_NCC && m.contrast >= MIN_CONTRAST;
				const sample = s.region.samples[k] as RegionSample;
				Object.assign(sample, {
					found,
					dx: m.dx,
					dy: m.dy,
					ncc: m.ncc,
					opacity: found ? Math.min(1, m.contrast) : 0,
				});
				if (found) {
					s.vel = s.prevFound
						? { dx: m.dx - s.pos.dx, dy: m.dy - s.pos.dy }
						: { dx: 0, dy: 0 };
					s.pos = { dx: m.dx, dy: m.dy };
				} else s.vel = { dx: 0, dy: 0 };
				s.prevFound = found;
				const box = {
					...s.region.box,
					x: s.region.box.x + s.pos.dx,
					y: s.region.box.y + s.pos.dy,
				};
				sample.centroid = changeStats(plane, first, box, floor).centroid;
				if (prev) {
					const later =
						prev.k > k ? { k: prev.k, plane: prev.plane } : { k, plane };
					const earlier = prev.k > k ? plane : prev.plane;
					const ls = s.region.samples[later.k] as RegionSample;
					const lbox = {
						...s.region.box,
						x: s.region.box.x + ls.dx,
						y: s.region.box.y + ls.dy,
					};
					ls.energy = changeStats(later.plane, earlier, lbox, floor).mean;
				}
			}
			prev = { k, plane };
		}
	}
	for (const s of states) {
		const smp = s.region.samples;
		const found = smp.map((p) => p.found);
		if (!found.some(Boolean))
			warnings.push(
				`region ${s.region.name}: the element was never found; its box stays at the region`,
			);
		const dx = fillLost(
			smp.map((p) => p.dx),
			found,
		);
		const dy = fillLost(
			smp.map((p) => p.dy),
			found,
		);
		smp.forEach((p, k) => {
			p.dx = dx[k] as number;
			p.dy = dy[k] as number;
		});
	}
	return states.map((s) => s.region);
}
