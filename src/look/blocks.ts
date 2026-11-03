import type { Lab } from "./colour.ts";
import type { Grid } from "./palette.ts";

/** A rectangle in grid cells: columns x..x+w-1, rows y..y+h-1. */
export interface CellRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Surface extends CellRect {
	/** Index into the flat fills. */
	colour: number;
	cells: number;
	/** Share of the bounding box the fill covers; text inside a card leaves holes. */
	fill: number;
}

// Lab units from a flat fill within which a cell belongs to it.
const MEMBER = 4;
// A fill region this small (share of the frame) is detail: text, icons, borders.
const MIN_SURFACE = 0.003;

/** Each cell's flat fill, -1 when it is near none: text, edges, images. */
export function labelCells(grid: Grid, fills: Lab[]): Int16Array {
	const n = grid.cols * grid.rows;
	const out = new Int16Array(n).fill(-1);
	const p = grid.lab;
	for (let i = 0; i < n; i++) {
		let best = -1;
		let bestD = MEMBER * MEMBER;
		fills.forEach((c, k) => {
			const d =
				((p[i * 3] as number) - c.l) ** 2 +
				((p[i * 3 + 1] as number) - c.a) ** 2 +
				((p[i * 3 + 2] as number) - c.b) ** 2;
			if (d <= bestD) {
				bestD = d;
				best = k;
			}
		});
		out[i] = best;
	}
	return out;
}

/** Connected same-fill regions large enough to be surfaces; `member` marks their cells. */
export function surfaces(
	grid: Grid,
	labels: Int16Array,
): { list: Surface[]; member: Uint8Array } {
	const { cols, rows } = grid;
	const seen = new Uint8Array(cols * rows);
	const member = new Uint8Array(cols * rows);
	const list: Surface[] = [];
	const min = MIN_SURFACE * cols * rows;
	for (let start = 0; start < cols * rows; start++) {
		const colour = labels[start] as number;
		if (colour < 0 || seen[start]) continue;
		const stack = [start];
		const cells: number[] = [];
		seen[start] = 1;
		let x0 = cols;
		let y0 = rows;
		let x1 = 0;
		let y1 = 0;
		while (stack.length) {
			const i = stack.pop() as number;
			cells.push(i);
			const x = i % cols;
			const y = (i - x) / cols;
			x0 = Math.min(x0, x);
			x1 = Math.max(x1, x);
			y0 = Math.min(y0, y);
			y1 = Math.max(y1, y);
			for (const [nx, ny] of [
				[x - 1, y],
				[x + 1, y],
				[x, y - 1],
				[x, y + 1],
			] as const) {
				if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
				const j = ny * cols + nx;
				if (!seen[j] && labels[j] === colour) {
					seen[j] = 1;
					stack.push(j);
				}
			}
		}
		if (cells.length < min) continue;
		for (const i of cells) member[i] = 1;
		const w = x1 - x0 + 1;
		const h = y1 - y0 + 1;
		list.push({
			x: x0,
			y: y0,
			w,
			h,
			colour,
			cells: cells.length,
			fill: cells.length / (w * h),
		});
	}
	return { list: list.sort((a, b) => b.cells - a.cells), member };
}

const MIN_FILL = 0.5;
// Surfaces spanning this share of the frame are the page itself.
const MAX_BLOCK = 0.9;

/** Uniform rectangles that are not the page background: cards, bars, buttons. */
export function blocksOf(
	grid: Grid,
	list: Surface[],
	background: number,
	minSideCells: number,
): Surface[] {
	return list.filter(
		(s) =>
			s.colour !== background &&
			s.fill >= MIN_FILL &&
			s.w >= minSideCells &&
			s.h >= minSideCells &&
			s.w * s.h < MAX_BLOCK * grid.cols * grid.rows,
	);
}

/** Text-line bands: runs of rows with ink (cells on no surface), split where a wide gap of columns has none. */
export function bandsOf(
	grid: Grid,
	member: Uint8Array,
	gapCells: number,
): CellRect[] {
	const { cols, rows } = grid;
	const ink = (x: number, y: number) => !member[y * cols + x];
	const rowInk = Array.from({ length: rows }, (_, y) => {
		let n = 0;
		for (let x = 0; x < cols; x++) if (ink(x, y)) n++;
		return n;
	});
	const runs: [number, number][] = [];
	for (let y = 0; y < rows; y++) {
		if ((rowInk[y] as number) < 2) continue;
		const last = runs.at(-1);
		if (last && y - last[1] <= 2) last[1] = y;
		else runs.push([y, y]);
	}
	const out: CellRect[] = [];
	for (const [y0, y1] of runs) {
		let start = -1;
		let lastInk = -1;
		let count = 0;
		const flush = () => {
			if (start >= 0 && count >= 4)
				out.push({ x: start, y: y0, w: lastInk - start + 1, h: y1 - y0 + 1 });
			start = -1;
			count = 0;
		};
		for (let x = 0; x < cols; x++) {
			let n = 0;
			for (let y = y0; y <= y1; y++) if (ink(x, y)) n++;
			if (n === 0) continue;
			if (start >= 0 && x - lastInk > gapCells) flush();
			if (start < 0) start = x;
			lastInk = x;
			count += n;
		}
		flush();
	}
	return out;
}
