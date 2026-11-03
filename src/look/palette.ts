import type { PNG } from "pngjs";
import { deltaE2000, type Lab, labToHex, rgbToLab } from "./colour.ts";
import type { Swatch } from "./schema.ts";

/** A frame averaged over square cells, one Lab colour per cell. */
export interface Grid {
	cols: number;
	rows: number;
	/** Frame pixels per cell side. */
	cell: number;
	/** l, a, b per cell, row by row. */
	lab: Float32Array;
}

// Cells this wide keep text lines apart while a 1280 px frame stays near 430 columns.
const MAX_COLS = 480;

export function gridOf(png: PNG): Grid {
	const cell = Math.max(1, Math.ceil(png.width / MAX_COLS));
	const cols = Math.floor(png.width / cell);
	const rows = Math.floor(png.height / cell);
	const lab = new Float32Array(cols * rows * 3);
	const n = cell * cell;
	for (let gy = 0; gy < rows; gy++)
		for (let gx = 0; gx < cols; gx++) {
			let r = 0;
			let g = 0;
			let b = 0;
			for (let y = gy * cell; y < (gy + 1) * cell; y++)
				for (let x = gx * cell; x < (gx + 1) * cell; x++) {
					const p = (y * png.width + x) * 4;
					r += png.data[p] as number;
					g += png.data[p + 1] as number;
					b += png.data[p + 2] as number;
				}
			const c = rgbToLab(r / n, g / n, b / n);
			const o = (gy * cols + gx) * 3;
			lab[o] = c.l;
			lab[o + 1] = c.a;
			lab[o + 2] = c.b;
		}
	return { cols, rows, cell, lab };
}

export const labAt = (points: Float32Array, i: number): Lab => ({
	l: points[i * 3] as number,
	a: points[i * 3 + 1] as number,
	b: points[i * 3 + 2] as number,
});

const d2 = (p: Float32Array, i: number, c: Lab) =>
	((p[i * 3] as number) - c.l) ** 2 +
	((p[i * 3 + 1] as number) - c.a) ** 2 +
	((p[i * 3 + 2] as number) - c.b) ** 2;

export interface Uniform {
	lab: Lab;
	count: number;
}

// Lab units: noise in a flat fill stays inside this radius, two design colours a few units apart stay apart.
const GATHER = 3;
const BIN = 2;

function meanOf(points: Float32Array, idx: number[]): Lab {
	const m = { l: 0, a: 0, b: 0 };
	for (const i of idx) {
		m.l += points[i * 3] as number;
		m.a += points[i * 3 + 1] as number;
		m.b += points[i * 3 + 2] as number;
	}
	const n = idx.length || 1;
	return { l: m.l / n, a: m.a / n, b: m.b / n };
}

/** Flat fills: the most common colour, then the next among what is left, and so on, most common first. */
export function uniformColours(
	points: Float32Array,
	{ minShare = 0.002, max = 12 }: { minShare?: number; max?: number } = {},
): Uniform[] {
	const n = points.length / 3;
	const key = (i: number) =>
		(Math.round((points[i * 3] as number) / BIN) * 1000 +
			Math.round((points[i * 3 + 1] as number) / BIN)) *
			1000 +
		Math.round((points[i * 3 + 2] as number) / BIN);
	const bins = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const k = key(i);
		const list = bins.get(k);
		if (list) list.push(i);
		else bins.set(k, [i]);
	}
	const taken = new Uint8Array(n);
	const out: Uniform[] = [];
	while (out.length < max) {
		let best: number[] = [];
		for (const list of bins.values()) {
			const free = list.filter((i) => !taken[i]);
			if (free.length > best.length) best = free;
		}
		if (best.length === 0) break;
		const centre = meanOf(points, best);
		const near: number[] = [];
		for (let i = 0; i < n; i++)
			if (!taken[i] && d2(points, i, centre) <= GATHER * GATHER) near.push(i);
		if (near.length < minShare * n) break;
		for (const i of near) taken[i] = 1;
		out.push({ lab: meanOf(points, near), count: near.length });
	}
	return out;
}

const SAMPLES = 20_000;
const MERGE_DE = 1.5;

/** Dominant colours by area: k-means in Lab seeded with the flat fills, then the farthest leftovers. */
export function kmeansPalette(
	points: Float32Array,
	seeds: Lab[],
	{ extra = 3, iterations = 8, minShare = 0.003 } = {},
): Swatch[] {
	const total = points.length / 3;
	const step = Math.max(1, Math.floor(total / SAMPLES));
	const idx: number[] = [];
	for (let i = 0; i < total; i += step) idx.push(i);
	const centres = seeds.slice(0, 9).map((s) => ({ ...s }));
	if (centres.length === 0 && idx.length)
		centres.push(labAt(points, idx[0] as number));
	for (let e = 0; e < extra; e++) {
		let far = -1;
		let farD = 0;
		for (const i of idx) {
			const d = Math.min(...centres.map((c) => d2(points, i, c)));
			if (d > farD) {
				farD = d;
				far = i;
			}
		}
		if (far < 0 || farD < 100) break;
		centres.push(labAt(points, far));
	}
	const assign = new Int32Array(idx.length);
	for (let it = 0; it < iterations; it++) {
		const sums = centres.map(() => ({ l: 0, a: 0, b: 0, n: 0 }));
		idx.forEach((i, j) => {
			let best = 0;
			let bestD = Number.POSITIVE_INFINITY;
			centres.forEach((c, k) => {
				const d = d2(points, i, c);
				if (d < bestD) {
					bestD = d;
					best = k;
				}
			});
			assign[j] = best;
			const s = sums[best] as { l: number; a: number; b: number; n: number };
			s.l += points[i * 3] as number;
			s.a += points[i * 3 + 1] as number;
			s.b += points[i * 3 + 2] as number;
			s.n++;
		});
		sums.forEach((s, k) => {
			if (s.n) centres[k] = { l: s.l / s.n, a: s.a / s.n, b: s.b / s.n };
		});
	}
	const counts = centres.map(() => 0);
	for (const k of assign) counts[k] = (counts[k] as number) + 1;
	const merged: { lab: Lab; n: number }[] = [];
	centres
		.map((lab, k) => ({ lab, n: counts[k] as number }))
		.sort((a, b) => b.n - a.n)
		.forEach((c) => {
			const into = merged.find((m) => deltaE2000(m.lab, c.lab) < MERGE_DE);
			if (into) into.n += c.n;
			else merged.push(c);
		});
	return merged
		.map((m) => ({ hex: labToHex(m.lab), share: m.n / (idx.length || 1) }))
		.filter((s) => s.share >= minShare)
		.map((s) => ({ hex: s.hex, share: Math.round(s.share * 1000) / 1000 }));
}
