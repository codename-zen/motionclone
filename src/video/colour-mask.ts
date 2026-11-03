import type { Rgba } from "./luma.ts";
import type { Rect } from "./match.ts";
import { components } from "./regions.ts";

// Lookups use 5 bits per channel.
const SHIFT = 3;
const SIDE = 32;
// A pixel matches a set colour within this RGB distance; h264 at crf 18 moves flat colours by a few levels.
export const MATCH = 28;
// A set colour covers at least this share of the reference window, in 4-bit bins.
const MIN_SHARE = 0.02;
export const CELL = 4;
const MIN_CELLS = 4;
const BRIDGE = 2;
// A row or column counts when it holds this many matching pixels, and a tenth of the fullest one.
const MIN_LINE = 3;
const LINE_SHARE = 0.1;

export type Rgb = [number, number, number];

export interface ColourReading {
	box: Rect;
	fill: number;
}

export const distance = (a: Rgb, b: Rgb) =>
	Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const bin5 = (d: Uint8Array, o: number) =>
	(((d[o] as number) >> SHIFT) << 10) |
	(((d[o + 1] as number) >> SHIFT) << 5) |
	((d[o + 2] as number) >> SHIFT);

const centre5 = (i: number) => (i << SHIFT) + (1 << (SHIFT - 1));

/** Every 5-bit bin whose centre lies within `dist` of one of the colours. */
export function lutOf(colours: Rgb[], dist: number): Uint8Array {
	const lut = new Uint8Array(SIDE ** 3);
	const r = Math.ceil(dist / (1 << SHIFT)) + 1;
	for (const c of colours) {
		const [i0, j0, k0] = c.map((v) => v >> SHIFT) as Rgb;
		for (let i = Math.max(0, i0 - r); i <= Math.min(SIDE - 1, i0 + r); i++)
			for (let j = Math.max(0, j0 - r); j <= Math.min(SIDE - 1, j0 + r); j++)
				for (
					let k = Math.max(0, k0 - r);
					k <= Math.min(SIDE - 1, k0 + r);
					k++
				) {
					const d2 =
						(centre5(i) - c[0]) ** 2 +
						(centre5(j) - c[1]) ** 2 +
						(centre5(k) - c[2]) ** 2;
					if (d2 <= dist * dist) lut[(i << 10) | (j << 5) | k] = 1;
				}
	}
	return lut;
}

export function maskOf(p: Rgba, lut: Uint8Array, a: Rect): Uint8Array {
	const m = new Uint8Array(a.w * a.h);
	for (let y = 0; y < a.h; y++)
		for (let x = 0; x < a.w; x++)
			m[y * a.w + x] = lut[
				bin5(p.data, 4 * ((a.y + y) * p.width + a.x + x))
			] as number;
	return m;
}

/** First and last index whose count reaches the line minimum. */
function span(counts: Uint32Array): [number, number] | null {
	const min = Math.max(MIN_LINE, LINE_SHARE * Math.max(...counts));
	const on = [...counts.keys()].filter((i) => (counts[i] as number) >= min);
	return on.length ? [on[0] as number, on.at(-1) as number] : null;
}

/** Box of the largest connected patch of matching pixels, from row and column counts. */
export function boxOf(m: Uint8Array, a: Rect): ColourReading | null {
	const cw = Math.ceil(a.w / CELL);
	const ch = Math.ceil(a.h / CELL);
	const cells = new Uint32Array(cw * ch);
	for (let y = 0; y < a.h; y++)
		for (let x = 0; x < a.w; x++)
			if (m[y * a.w + x]) {
				const c = Math.floor(y / CELL) * cw + Math.floor(x / CELL);
				cells[c] = (cells[c] as number) + 1;
			}
	const on = Uint8Array.from(cells, (v) => (v * 2 >= CELL * CELL ? 1 : 0));
	const top = components(on, cw, ch, MIN_CELLS)[0];
	if (!top) return null;
	const x0 = Math.max(0, (top.x - 1) * CELL);
	const y0 = Math.max(0, (top.y - 1) * CELL);
	const x1 = Math.min(a.w, (top.x + top.w + 1) * CELL);
	const y1 = Math.min(a.h, (top.y + top.h + 1) * CELL);
	const rows = new Uint32Array(y1 - y0);
	const cols = new Uint32Array(x1 - x0);
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++)
			if (m[y * a.w + x]) {
				rows[y - y0] = (rows[y - y0] as number) + 1;
				cols[x - x0] = (cols[x - x0] as number) + 1;
			}
	const ys = span(rows);
	const xs = span(cols);
	if (!ys || !xs) return null;
	const box = {
		x: a.x + x0 + xs[0],
		y: a.y + y0 + ys[0],
		w: xs[1] - xs[0] + 1,
		h: ys[1] - ys[0] + 1,
	};
	let n = 0;
	for (let y = box.y - a.y; y < box.y - a.y + box.h; y++)
		for (let x = box.x - a.x; x < box.x - a.x + box.w; x++)
			n += m[y * a.w + x] as number;
	return { box, fill: n / (box.w * box.h) };
}

/**
 * Box of the largest patch of cells holding a quarter of matching pixels, bridged across gaps of up to
 * two cells, so a colour broken up by a pattern still spans the whole element.
 */
export function looseBox(p: Rgba, lut: Uint8Array, a: Rect): Rect | null {
	const m = maskOf(p, lut, a);
	const cw = Math.ceil(a.w / CELL);
	const ch = Math.ceil(a.h / CELL);
	const cells = new Uint32Array(cw * ch);
	for (let y = 0; y < a.h; y++)
		for (let x = 0; x < a.w; x++)
			if (m[y * a.w + x]) {
				const c = Math.floor(y / CELL) * cw + Math.floor(x / CELL);
				cells[c] = (cells[c] as number) + 1;
			}
	const on = new Uint8Array(cw * ch);
	for (let j = 0; j < ch; j++)
		for (let i = 0; i < cw; i++) {
			if ((cells[j * cw + i] as number) * 4 < CELL * CELL) continue;
			for (
				let y = Math.max(0, j - BRIDGE);
				y <= Math.min(ch - 1, j + BRIDGE);
				y++
			)
				for (
					let x = Math.max(0, i - BRIDGE);
					x <= Math.min(cw - 1, i + BRIDGE);
					x++
				)
					on[y * cw + x] = 1;
		}
	const top = components(on, cw, ch, MIN_CELLS)[0];
	if (!top) return null;
	const x0 = a.x + (top.x + BRIDGE) * CELL;
	const y0 = a.y + (top.y + BRIDGE) * CELL;
	const x1 = Math.min(a.x + a.w, a.x + (top.x + top.w - BRIDGE) * CELL);
	const y1 = Math.min(a.y + a.h, a.y + (top.y + top.h - BRIDGE) * CELL);
	return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Mean colours of the 4-bit bins that cover at least MIN_SHARE of the window. */
export function dominant(p: Rgba, win: Rect): Rgb[] {
	const n = new Uint32Array(4096);
	const sum = new Float64Array(4096 * 3);
	for (let y = win.y; y < win.y + win.h; y++)
		for (let x = win.x; x < win.x + win.w; x++) {
			const o = 4 * (y * p.width + x);
			const d = p.data;
			const b =
				(((d[o] as number) >> 4) << 8) |
				(((d[o + 1] as number) >> 4) << 4) |
				((d[o + 2] as number) >> 4);
			n[b] = (n[b] as number) + 1;
			for (let c = 0; c < 3; c++)
				sum[3 * b + c] = (sum[3 * b + c] as number) + (d[o + c] as number);
		}
	const out: Rgb[] = [];
	n.forEach((count, b) => {
		if (count >= MIN_SHARE * win.w * win.h)
			out.push([0, 1, 2].map((c) => (sum[3 * b + c] as number) / count) as Rgb);
	});
	return out;
}

const inside = (r: Rect, x: number, y: number) =>
	x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/** Matches of a colour in the area within `dist`: all of them, and those inside the box. */
export function countIn(
	p: Rgba,
	a: Rect,
	c: Rgb,
	dist: number,
	box: Rect | null,
): { all: number; inBox: number } {
	const m = maskOf(p, lutOf([c], dist), a);
	let all = 0;
	let inBox = 0;
	for (let y = 0; y < a.h; y++)
		for (let x = 0; x < a.w; x++)
			if (m[y * a.w + x]) {
				all++;
				if (box && inside(box, a.x + x, a.y + y)) inBox++;
			}
	return { all, inBox };
}
