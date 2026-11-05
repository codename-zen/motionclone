import { downsample, type Plane } from "./luma.ts";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A zero-mean template. */
export interface Grid {
	w: number;
	h: number;
	t: Float32Array;
	sumSq: number;
}

export interface Frame {
	full: Plane;
	half: Plane;
	coarse: Plane;
	/** Eighth resolution, for the wide search that re-acquires a lost element. */
	tiny: Plane;
}

export interface Hit {
	/** Top-left of the template in the plane. */
	x: number;
	y: number;
	/** Normalised cross-correlation with the template, -1..1. */
	ncc: number;
	/** Contrast against the template: the slope of frame values on template values. */
	contrast: number;
	/** Standard deviation of the frame values under the template, luma levels. */
	spread: number;
}

export const COARSE = 4;
export const TINY = 8;

export function pyramid(full: Plane): Frame {
	const half = downsample(full, 2);
	const coarse = downsample(half, COARSE / 2);
	return { full, half, coarse, tiny: downsample(coarse, TINY / COARSE) };
}

export function gridOf(t: Float32Array, w: number, h: number): Grid {
	let sum = 0;
	for (let i = 0; i < t.length; i++) sum += t[i] as number;
	const mean = sum / t.length;
	let sumSq = 0;
	for (let i = 0; i < t.length; i++) {
		const v = (t[i] as number) - mean;
		t[i] = v;
		sumSq += v * v;
	}
	return { w, h, t, sumSq };
}

/**
 * NCC, contrast and patch spread of the template with its top-left at (x0, y0). A template that leaves the plane
 * scores null, unless it keeps `1 - overhang` of its width and height inside: then the part inside is scored.
 */
export function score(p: Plane, g: Grid, x0: number, y0: number, overhang = 0) {
	if (x0 < 0 || y0 < 0 || x0 + g.w > p.width || y0 + g.h > p.height)
		return overhang > 0 ? partialScore(p, g, x0, y0, overhang) : null;
	let sp = 0;
	let spp = 0;
	let spt = 0;
	const d = p.data;
	const t = g.t;
	for (let j = 0; j < g.h; j++) {
		let o = (y0 + j) * p.width + x0;
		let q = j * g.w;
		for (let i = 0; i < g.w; i++, o++, q++) {
			const v = d[o] as number;
			sp += v;
			spp += v * v;
			spt += v * (t[q] as number);
		}
	}
	const n = g.w * g.h;
	const varP = spp - (sp * sp) / n;
	const denom = Math.sqrt(Math.max(varP, 0) * g.sumSq);
	return {
		ncc: denom > 1e-9 ? spt / denom : 0,
		contrast: g.sumSq > 1e-9 ? spt / g.sumSq : 0,
		spread: Math.sqrt(Math.max(varP, 0) / n),
	};
}

/** The scores of `score` over the part of the template inside the plane, against that part's own mean. */
function partialScore(
	p: Plane,
	g: Grid,
	x0: number,
	y0: number,
	overhang: number,
) {
	const i0 = Math.max(0, -x0);
	const j0 = Math.max(0, -y0);
	const i1 = Math.min(g.w, p.width - x0);
	const j1 = Math.min(g.h, p.height - y0);
	if (i1 - i0 < (1 - overhang) * g.w || j1 - j0 < (1 - overhang) * g.h)
		return null;
	let sp = 0;
	let spp = 0;
	let spt = 0;
	let st = 0;
	let stt = 0;
	for (let j = j0; j < j1; j++)
		for (let i = i0; i < i1; i++) {
			const v = p.data[(y0 + j) * p.width + x0 + i] as number;
			const t = g.t[j * g.w + i] as number;
			sp += v;
			spp += v * v;
			spt += v * t;
			st += t;
			stt += t * t;
		}
	const n = (i1 - i0) * (j1 - j0);
	const varP = Math.max(0, spp - (sp * sp) / n);
	const varT = Math.max(0, stt - (st * st) / n);
	const cov = spt - (sp * st) / n;
	const denom = Math.sqrt(varP * varT);
	return {
		ncc: denom > 1e-9 ? cov / denom : 0,
		contrast: varT > 1e-9 ? cov / varT : 0,
		spread: Math.sqrt(varP / n),
	};
}

/** Best integer placement within `r` pixels of (cx, cy); `overhang` as for `score`. */
export function best(
	p: Plane,
	g: Grid,
	cx: number,
	cy: number,
	r: number,
	overhang = 0,
): Hit {
	let top: Hit = { x: cx, y: cy, ncc: -2, contrast: 0, spread: 0 };
	for (let y = cy - r; y <= cy + r; y++)
		for (let x = cx - r; x <= cx + r; x++) {
			const s = score(p, g, x, y, overhang);
			if (s && s.ncc > top.ncc) top = { x, y, ...s };
		}
	return top;
}

/** Vertex of the parabola through three samples, as an offset in -0.5..0.5. */
export function vertex(
	a: number | undefined,
	b: number,
	c: number | undefined,
): number {
	if (a === undefined || c === undefined) return 0;
	const den = a - 2 * b + c;
	return den < 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den))) : 0;
}

/** Sub-pixel refinement of an integer hit on each axis, in plane pixels. */
export function subPixel(
	p: Plane,
	g: Grid,
	h: Hit,
	overhang = 0,
): { x: number; y: number } {
	const at = (x: number, y: number) => score(p, g, x, y, overhang)?.ncc;
	return {
		x: h.x + vertex(at(h.x - 1, h.y), h.ncc, at(h.x + 1, h.y)),
		y: h.y + vertex(at(h.x, h.y - 1), h.ncc, at(h.x, h.y + 1)),
	};
}
