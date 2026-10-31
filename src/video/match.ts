import { downsample, type Plane } from "./luma.ts";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface Template extends Rect {
	/** Zero-mean template values. */
	t: Float32Array;
	sumSq: number;
}

export interface Templates {
	full: Template;
	coarse: Template | null;
}

export interface Frame {
	full: Plane;
	coarse: Plane;
}

export interface Match {
	dx: number;
	dy: number;
	/** Normalised cross-correlation with the template, -1..1. */
	ncc: number;
	/** Contrast against the template: the slope of frame values on template values, 1 at the reference frame. */
	contrast: number;
}

export const COARSE = 4;
const COARSE_RADIUS = 10;
const FINE_RADIUS = 3;
const FLAT_RADIUS = 16;
const MIN_COARSE_SIDE = 8;

export const pyramid = (full: Plane): Frame => ({
	full,
	coarse: downsample(full, COARSE),
});

function template(p: Plane, r: Rect): Template {
	const t = new Float32Array(r.w * r.h);
	let sum = 0;
	for (let j = 0; j < r.h; j++)
		for (let i = 0; i < r.w; i++) {
			const v = p.data[(r.y + j) * p.width + r.x + i] as number;
			t[j * r.w + i] = v;
			sum += v;
		}
	const mean = sum / t.length;
	let sumSq = 0;
	for (let i = 0; i < t.length; i++) {
		const v = (t[i] as number) - mean;
		t[i] = v;
		sumSq += v * v;
	}
	return { ...r, t, sumSq };
}

export function makeTemplates(ref: Frame, r: Rect): Templates {
	const c = {
		x: Math.floor(r.x / COARSE),
		y: Math.floor(r.y / COARSE),
		w: Math.floor(r.w / COARSE),
		h: Math.floor(r.h / COARSE),
	};
	const fits = c.x + c.w <= ref.coarse.width && c.y + c.h <= ref.coarse.height;
	return {
		full: template(ref.full, r),
		coarse:
			c.w >= MIN_COARSE_SIDE && c.h >= MIN_COARSE_SIDE && fits
				? template(ref.coarse, c)
				: null,
	};
}

/** NCC and contrast of the template shifted by (dx, dy); null when the shifted box leaves the frame. */
function score(p: Plane, tpl: Template, dx: number, dy: number) {
	const x0 = tpl.x + dx;
	const y0 = tpl.y + dy;
	if (x0 < 0 || y0 < 0 || x0 + tpl.w > p.width || y0 + tpl.h > p.height)
		return null;
	let sp = 0;
	let spp = 0;
	let spt = 0;
	const d = p.data;
	const t = tpl.t;
	for (let j = 0; j < tpl.h; j++) {
		let o = (y0 + j) * p.width + x0;
		let q = j * tpl.w;
		for (let i = 0; i < tpl.w; i++, o++, q++) {
			const v = d[o] as number;
			sp += v;
			spp += v * v;
			spt += v * (t[q] as number);
		}
	}
	const n = tpl.w * tpl.h;
	const varP = spp - (sp * sp) / n;
	const denom = Math.sqrt(Math.max(varP, 0) * tpl.sumSq);
	return {
		ncc: denom > 1e-9 ? spt / denom : 0,
		contrast: tpl.sumSq > 1e-9 ? spt / tpl.sumSq : 0,
	};
}

function best(p: Plane, tpl: Template, cx: number, cy: number, r: number) {
	let top = { dx: cx, dy: cy, ncc: -2, contrast: 0 };
	for (let dy = cy - r; dy <= cy + r; dy++)
		for (let dx = cx - r; dx <= cx + r; dx++) {
			const s = score(p, tpl, dx, dy);
			if (s && s.ncc > top.ncc) top = { dx, dy, ...s };
		}
	return top;
}

// Vertex of the parabola through three samples, as an offset in -0.5..0.5.
function vertex(
	a: number | undefined,
	b: number,
	c: number | undefined,
): number {
	if (a === undefined || c === undefined) return 0;
	const den = a - 2 * b + c;
	return den < 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den))) : 0;
}

/** Find the template near a predicted shift: coarse search, integer refinement, then sub-pixel parabolas. */
export function locate(
	f: Frame,
	tpls: Templates,
	pred: { dx: number; dy: number },
): Match {
	let cx = Math.round(pred.dx);
	let cy = Math.round(pred.dy);
	let radius = FLAT_RADIUS;
	if (tpls.coarse) {
		const c = best(
			f.coarse,
			tpls.coarse,
			Math.round(pred.dx / COARSE),
			Math.round(pred.dy / COARSE),
			COARSE_RADIUS,
		);
		cx = c.dx * COARSE;
		cy = c.dy * COARSE;
		radius = FINE_RADIUS + COARSE / 2;
	}
	const m = best(f.full, tpls.full, cx, cy, radius);
	const at = (dx: number, dy: number) => score(f.full, tpls.full, dx, dy)?.ncc;
	return {
		dx: m.dx + vertex(at(m.dx - 1, m.dy), m.ncc, at(m.dx + 1, m.dy)),
		dy: m.dy + vertex(at(m.dx, m.dy - 1), m.ncc, at(m.dx, m.dy + 1)),
		ncc: m.ncc,
		contrast: m.contrast,
	};
}
