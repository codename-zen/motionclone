import type { Plane } from "./luma.ts";
import type { Rect } from "./match.ts";

const MIN_BLOB_CELLS = 16;
const MIN_LINE_PIXELS = 2;

export interface NamedRect extends Rect {
	name: string;
}

/** Shrink a rect to the content that differs between the two end frames; unchanged when nothing differs. */
export function tighten(a: Plane, b: Plane, r: Rect, floor: number): Rect {
	const rows = new Uint32Array(r.h);
	const cols = new Uint32Array(r.w);
	for (let j = 0; j < r.h; j++)
		for (let i = 0; i < r.w; i++) {
			const o = (r.y + j) * a.width + r.x + i;
			if (Math.abs((a.data[o] as number) - (b.data[o] as number)) > floor) {
				rows[j] = (rows[j] as number) + 1;
				cols[i] = (cols[i] as number) + 1;
			}
		}
	const span = (counts: Uint32Array): [number, number] | null => {
		const on = [...counts.keys()].filter(
			(i) => (counts[i] as number) >= MIN_LINE_PIXELS,
		);
		return on.length ? [on[0] as number, on.at(-1) as number] : null;
	};
	const ys = span(rows);
	const xs = span(cols);
	if (!ys || !xs) return r;
	return {
		x: r.x + xs[0],
		y: r.y + ys[0],
		w: xs[1] - xs[0] + 1,
		h: ys[1] - ys[0] + 1,
	};
}

export function spread(p: Plane, r: Rect): number {
	let s = 0;
	let ss = 0;
	for (let j = 0; j < r.h; j++)
		for (let i = 0; i < r.w; i++) {
			const v = p.data[(r.y + j) * p.width + r.x + i] as number;
			s += v;
			ss += v * v;
		}
	const n = r.w * r.h;
	return ss / n - (s / n) ** 2;
}

/** Share of the luma variance of `win` that lies inside `box`. */
export function structureInside(p: Plane, win: Rect, box: Rect): number {
	let sum = 0;
	for (let y = win.y; y < win.y + win.h; y++)
		for (let x = win.x; x < win.x + win.w; x++)
			sum += p.data[y * p.width + x] as number;
	const mean = sum / (win.w * win.h);
	let all = 0;
	let inside = 0;
	for (let y = win.y; y < win.y + win.h; y++)
		for (let x = win.x; x < win.x + win.w; x++) {
			const d = ((p.data[y * p.width + x] as number) - mean) ** 2;
			all += d;
			if (x >= box.x && y >= box.y && x < box.x + box.w && y < box.y + box.h)
				inside += d;
		}
	return all > 0 ? inside / all : 0;
}

/** The end frame that shows more structure inside the rect: that is where the element is visible. */
export const pickRef = (
	first: Plane,
	last: Plane,
	r: Rect,
): "first" | "last" => (spread(first, r) >= spread(last, r) ? "first" : "last");

/** Bounding boxes of 8-connected mask components with at least `min` cells, largest first. */
export function components(
	mask: Uint8Array,
	w: number,
	h: number,
	min = MIN_BLOB_CELLS,
): Rect[] {
	const seen = new Uint8Array(mask.length);
	const out: (Rect & { cells: number })[] = [];
	for (let start = 0; start < mask.length; start++) {
		if (!mask[start] || seen[start]) continue;
		const stack = [start];
		seen[start] = 1;
		let [x0, y0, x1, y1, cells] = [w, h, 0, 0, 0];
		while (stack.length) {
			const i = stack.pop() as number;
			const x = i % w;
			const y = (i - x) / w;
			[x0, y0, x1, y1] = [
				Math.min(x0, x),
				Math.min(y0, y),
				Math.max(x1, x),
				Math.max(y1, y),
			];
			cells++;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx;
					const ny = y + dy;
					const n = ny * w + nx;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[n] || seen[n])
						continue;
					seen[n] = 1;
					stack.push(n);
				}
		}
		if (cells >= min)
			out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, cells });
	}
	return out.sort((a, b) => b.cells - a.cells);
}
