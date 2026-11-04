import type { PNG } from "pngjs";
import { deltaEHex, parseHex } from "./colour.ts";
import type { Block, Panel } from "./schema.ts";

// A panel spans at least this share of the screen's width and height.
const MIN_W = 0.6;
const MIN_H = 0.1;
// Panel and what is around it must differ this much to read an edge.
const MIN_DELTA_E = 10;
// A row whose panel starts this many frame px in from the panel's side lies in a rounded corner.
const MIN_INSET = 0.5;
// A pixel this much panel is inside it: scans stop there, before any content of the panel.
const FULL = 0.95;
// Corners are read down to this share of the panel's width.
const MAX_RADIUS = 0.25;

type Rgb = [number, number, number];

const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const median = (v: number[]) =>
	v.length ? ([...v].sort((a, b) => a - b)[v.length >> 1] as number) : null;

/** How much of a pixel is panel: its colour projected from the outside colour to the panel's, 0..1. */
function coverage(png: PNG, inside: Rgb, outside: Rgb) {
	const d = inside.map((v, c) => v - (outside[c] as number));
	const n = d.reduce((s, v) => s + v * v, 0);
	return (x: number, y: number) => {
		const p = (y * png.width + x) * 4;
		let dot = 0;
		for (let c = 0; c < 3; c++)
			dot +=
				((png.data[p + c] as number) - (outside[c] as number)) *
				(d[c] as number);
		return Math.min(1, Math.max(0, dot / n));
	};
}

function meanRgb(
	png: PNG,
	x0: number,
	x1: number,
	y0: number,
	y1: number,
): Rgb {
	const s: Rgb = [0, 0, 0];
	let n = 0;
	for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y++)
		for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) {
			const p = (y * png.width + x) * 4;
			for (let c = 0; c < 3; c++)
				s[c] = (s[c] as number) + (png.data[p + c] as number);
			n++;
		}
	return n ? (s.map((v) => v / n) as Rgb) : s;
}

/** Sub-pixel distance to the panel along a scan: the sum of what is not panel, up to its first full pixel. */
function uncovered(at: (k: number) => number, n: number): number {
	let e = 0;
	for (let k = 0; k < n; k++) {
		const c = at(k);
		if (c >= FULL) break;
		e += 1 - c;
	}
	return e;
}

const hex = (c: Rgb) =>
	`#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/**
 * The large panel of a frame: the widest flat block that is not the background, with its top edge found to a
 * sub-pixel (where the colour crosses from what is above it to the panel's) and the radius of its top corners from
 * their curvature. Edges and radius are in frame px.
 */
export function panelOf(
	png: PNG,
	blocks: readonly Block[],
	cssPerPx: number,
): Panel | null {
	const block = blocks
		.filter((b) => b.w >= MIN_W && b.h >= MIN_H && b.y > 0.01)
		.sort((a, b) => b.w * b.h - a.w * a.h)[0];
	if (!block) return null;
	const W = png.width;
	const H = png.height;
	const left = Math.round(block.x * W);
	const right = Math.round((block.x + block.w) * W);
	const top0 = Math.round(block.y * H);
	const reach = Math.max(4, Math.round(0.01 * H));
	const midL = Math.round(left + 0.3 * (right - left));
	const midR = Math.round(left + 0.7 * (right - left));
	const outside = meanRgb(png, midL, midR, top0 - 2 * reach, top0 - reach);
	const p = parseHex(block.hex);
	const inside: Rgb = [p.r, p.g, p.b];
	if (deltaEHex(hex(outside), block.hex) < MIN_DELTA_E) return null;
	const cov = coverage(png, inside, outside);
	const y0 = Math.max(0, top0 - reach);
	const y1 = Math.min(H, top0 + reach);
	const tops: number[] = [];
	for (let x = midL; x < midR; x++)
		tops.push(y0 + uncovered((k) => cov(x, y0 + k), y1 - y0));
	const top = median(tops) as number;
	const radius = cornerRadius(cov, left, right, top, W, H);
	return {
		hex: block.hex,
		x: block.x,
		w: block.w,
		y: r4(top / H),
		radius: r1(radius * cssPerPx),
	};
}

/**
 * Radius of the top corners. Each row's inset from the panel's side, a sub-pixel sum of what is not panel, gives
 * the radius of a circle through it: R = i + d + sqrt(2 i d) at depth d under the top edge. The median of both corners.
 */
function cornerRadius(
	cov: (x: number, y: number) => number,
	left: number,
	right: number,
	top: number,
	W: number,
	H: number,
): number {
	const maxR = Math.round(MAX_RADIUS * (right - left));
	const span = maxR + 4;
	const rows = Math.min(H - 1, Math.ceil(top + maxR + 4));
	const side = (dir: 1 | -1) => {
		const start =
			dir === 1 ? Math.max(0, left - 4) : Math.min(W - 1, right + 3);
		const n = dir === 1 ? Math.min(span, W - start) : Math.min(span, start + 1);
		const edgeAt = (y: number) => uncovered((k) => cov(start + dir * k, y), n);
		const yTop = Math.ceil(top);
		const below = [] as number[];
		for (let y = rows - 3; y <= rows; y++) below.push(edgeAt(y));
		const base = median(below) as number;
		const radii: number[] = [];
		for (let y = yTop; y < rows - 3; y++) {
			const i = edgeAt(y) - base;
			const d = y + 0.5 - top;
			if (i >= MIN_INSET && d > 0) radii.push(i + d + Math.sqrt(2 * i * d));
		}
		return radii.length >= 2 ? median(radii) : 0;
	};
	return ((side(1) as number) + (side(-1) as number)) / 2;
}
