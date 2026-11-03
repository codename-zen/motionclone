import type { Rgba } from "./luma.ts";
import type { Rect } from "./match.ts";
import { components } from "./regions.ts";

// Lookups use 5 bits per channel.
const SHIFT = 3;
const SIDE = 32;
// A pixel matches a set colour within this RGB distance; h264 at crf 18 moves flat colours by a few levels.
const MATCH = 28;
// A colour is rare in the other end when this share of its region at most lies within 1.5x the match distance.
const RARE_DIST = 42;
const MAX_OTHER = 0.005;
// A set colour covers at least this share of the reference window, in 4-bit bins.
const MIN_SHARE = 0.02;
// At least this share of a set colour's pixels lies inside the element's box, so background colours drop out.
const INSIDE = 0.8;
// The element is mostly made of its set colours.
const MIN_FILL = 0.5;
const CELL = 4;
const MIN_CELLS = 4;
// A row or column counts when it holds this many matching pixels, and a tenth of the fullest one.
const MIN_LINE = 3;
const LINE_SHARE = 0.1;
// Per frame: fill against the reference and aspect change under which the box is the element, uniformly scaled.
const MIN_FILL_RATIO = 0.6;
const MAX_ASPECT = 0.1;

/** Colours that mark one element, and its box at the reference end. */
export interface ColourModel {
	lut: Uint8Array;
	/** Where the element is looked for: the region, frame pixels. */
	area: Rect;
	box: Rect;
	/** Share of the box made of set colours. */
	fill: number;
}

export interface ColourReading {
	box: Rect;
	fill: number;
}

type Rgb = [number, number, number];

const distance = (a: Rgb, b: Rgb) =>
	Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const bin5 = (d: Uint8Array, o: number) =>
	(((d[o] as number) >> SHIFT) << 10) |
	(((d[o + 1] as number) >> SHIFT) << 5) |
	((d[o + 2] as number) >> SHIFT);

const centre5 = (i: number) => (i << SHIFT) + (1 << (SHIFT - 1));

/** Every 5-bit bin whose centre lies within `dist` of one of the colours. */
function lutOf(colours: Rgb[], dist: number): Uint8Array {
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

function maskOf(p: Rgba, lut: Uint8Array, a: Rect): Uint8Array {
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
function boxOf(m: Uint8Array, a: Rect): ColourReading | null {
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

/** Mean colours of the 4-bit bins that cover at least MIN_SHARE of the window. */
function dominant(p: Rgba, win: Rect): Rgb[] {
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

/** Share of the area's pixels that lie within `dist` of the colour. */
function share(p: Rgba, a: Rect, c: Rgb, dist: number): number {
	const m = maskOf(p, lutOf([c], dist), a);
	let k = 0;
	for (const v of m) k += v;
	return k / m.length;
}

const inside = (r: Rect, x: number, y: number) =>
	x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/** Share of a colour's matches in the area that fall inside the box. */
function purity(p: Rgba, a: Rect, c: Rgb, box: Rect): number {
	const m = maskOf(p, lutOf([c], MATCH), a);
	let all = 0;
	let inBox = 0;
	for (let y = 0; y < a.h; y++)
		for (let x = 0; x < a.w; x++)
			if (m[y * a.w + x]) {
				all++;
				if (inside(box, a.x + x, a.y + y)) inBox++;
			}
	return all ? inBox / all : 0;
}

/**
 * The element's distinctive colours: dominant in the reference window, rare in the region at the other end,
 * away from the window's other dominant colours, and mostly inside the box they form;
 * null when they do not make up most of that box.
 */
export function colourModel(
	ref: Rgba,
	other: Rgba,
	win: Rect,
	area: Rect,
): ColourModel | null {
	const all = dominant(ref, win);
	const rare = all.map((c) => share(other, area, c, RARE_DIST) <= MAX_OTHER);
	// A colour near the background of the reference end would match that background too.
	const background = all.filter((_, i) => !rare[i]);
	let colours = all.filter(
		(c, i) => rare[i] && background.every((d) => distance(c, d) > RARE_DIST),
	);
	if (colours.length === 0) return null;
	const first = boxOf(maskOf(ref, lutOf(colours, MATCH), area), area);
	if (!first) return null;
	colours = colours.filter((c) => purity(ref, area, c, first.box) >= INSIDE);
	if (colours.length === 0) return null;
	const lut = lutOf(colours, MATCH);
	const at = boxOf(maskOf(ref, lut, area), area);
	if (!at || at.fill < MIN_FILL) return null;
	return { lut, area, box: at.box, fill: at.fill };
}

/** The element's box in a frame, or null when its colours do not form a uniformly scaled copy of it. */
export function readColour(m: ColourModel, p: Rgba): ColourReading | null {
	const r = boxOf(maskOf(p, m.lut, m.area), m.area);
	if (!r || r.fill < MIN_FILL_RATIO * m.fill) return null;
	const aspect = Math.log(r.box.w / r.box.h / (m.box.w / m.box.h));
	return Math.abs(aspect) <= MAX_ASPECT ? r : null;
}

/** Scale against the reference box and centre of a reading, frame pixels. */
export function poseOf(m: ColourModel, r: ColourReading) {
	return {
		s: Math.sqrt((r.box.w * r.box.h) / (m.box.w * m.box.h)),
		x: r.box.x + r.box.w / 2,
		y: r.box.y + r.box.h / 2,
	};
}
