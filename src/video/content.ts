import type { Plane } from "./luma.ts";
import { COARSE, type Rect } from "./match.ts";
import { components } from "./regions.ts";
import type { Travel } from "./travel.ts";

const CELL = COARSE;
// A 3x3 cell window needs this luma standard deviation to hold content.
const MIN_STD = 4;
// Content whose zero-mean structure correlates this well in place only changed colour, as under a page flip.
const RECOLOURED = 0.9;
// Cells this close to the travelling element's box belong to its edge: rows fitting trimmed, plus
// the cell window.
const EDGE_PAD = 16;
// A box within one travel block of the frame edge at either state continues past it: fitting moves box
// edges by up to a block.
const REACH = 32;
// Content pieces closer than this form one region.
const JOIN = 24;
// Room around the content.
const PAD = 8;
const MIN_CELLS = 16;

/** A region of content that stays in place, and a frame where it shows uncovered. */
export interface ContentRect extends Rect {
	at: number;
}

/** One transition between whole-frame rest states, with what travels in it. */
export interface Transition {
	a: { k: number; plane: Plane };
	b: { k: number; plane: Plane };
	travel: Travel | null;
}

/**
 * Where the travelling element is at each state, grown by `pad`: its box, carried to the frame edge on sides
 * where the box comes near it at either state, because an element larger than the frame continues there.
 */
function covers(t: Travel, frame: Rect, pad: number): [Rect, Rect] {
	const at = [t.box, { ...t.box, x: t.box.x + t.dx, y: t.box.y + t.dy }];
	const near = (f: (r: Rect) => number) => at.some((r) => f(r) <= REACH);
	const left = near((r) => r.x - frame.x);
	const top = near((r) => r.y - frame.y);
	const right = near((r) => frame.x + frame.w - r.x - r.w);
	const bottom = near((r) => frame.y + frame.h - r.y - r.h);
	return at.map((r) => {
		const x0 = left ? frame.x : r.x - pad;
		const y0 = top ? frame.y : r.y - pad;
		const x1 = right ? frame.x + frame.w : r.x + r.w + pad;
		const y1 = bottom ? frame.y + frame.h : r.y + r.h + pad;
		return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
	}) as [Rect, Rect];
}

/** Per-cell sums of a, b, a^2, b^2 and ab. */
function cellSums(a: Plane, b: Plane, cw: number, ch: number) {
	const s = Array.from({ length: 5 }, () => new Float64Array(cw * ch));
	for (let y = 0; y < ch * CELL; y++)
		for (let x = 0; x < cw * CELL; x++) {
			const o = y * a.width + x;
			const c = Math.floor(y / CELL) * cw + Math.floor(x / CELL);
			const va = a.data[o] as number;
			const vb = b.data[o] as number;
			const add = [va, vb, va * va, vb * vb, va * vb];
			for (let i = 0; i < 5; i++)
				(s[i] as Float64Array)[c] =
					((s[i] as Float64Array)[c] as number) + (add[i] as number);
		}
	return s;
}

const holds = (r: Rect, x: number, y: number) =>
	x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/**
 * Cells of the area whose content changed in place between the two states, outside the travelling element: content
 * the element reveals or covers, or content that changed where it is. Content that only changed colour does not
 * count. Each marked cell records the frame where it shows.
 */
function markTransition(
	t: Transition & { travel: Travel },
	area: Rect,
	frame: Rect,
	cw: number,
	ch: number,
	shows: Int32Array,
): void {
	const [ea, eb] = covers(t.travel, frame, 0);
	const [pa, pb] = covers(t.travel, frame, EDGE_PAD);
	const s = cellSums(t.a.plane, t.b.plane, cw, ch);
	for (let cy = 0; cy < ch; cy++)
		for (let cx = 0; cx < cw; cx++) {
			const px = cx * CELL + CELL / 2;
			const py = cy * CELL + CELL / 2;
			if (!holds(area, px, py)) continue;
			const inA = holds(ea, px, py);
			const inB = holds(eb, px, py);
			if ((!inA && holds(pa, px, py)) || (!inB && holds(pb, px, py))) continue;
			if (inA && inB) continue;
			const w = [0, 0, 0, 0, 0];
			let n = 0;
			for (let j = Math.max(0, cy - 1); j <= Math.min(ch - 1, cy + 1); j++)
				for (let i = Math.max(0, cx - 1); i <= Math.min(cw - 1, cx + 1); i++) {
					for (let m = 0; m < 5; m++)
						w[m] =
							(w[m] as number) + ((s[m] as Float64Array)[j * cw + i] as number);
					n += CELL * CELL;
				}
			const [sa, sb, saa, sbb, sab] = w.map((v) => v / n) as number[];
			const va = Math.max(0, (saa as number) - (sa as number) ** 2);
			const vb = Math.max(0, (sbb as number) - (sb as number) ** 2);
			const showsA = !inA && Math.sqrt(va) >= MIN_STD;
			const showsB = !inB && Math.sqrt(vb) >= MIN_STD;
			if (!showsA && !showsB) continue;
			if (!inA && !inB && showsA && showsB) {
				const r =
					((sab as number) - (sa as number) * (sb as number)) /
					Math.sqrt(va * vb);
				if (Math.abs(r) >= RECOLOURED) continue;
			}
			shows[cy * cw + cx] = showsB ? t.b.k : t.a.k;
		}
}

/** The mask grown by `cells` in every direction. */
function grow(
	mask: Uint8Array,
	cw: number,
	ch: number,
	cells: number,
): Uint8Array {
	const out = new Uint8Array(mask.length);
	for (let y = 0; y < ch; y++)
		for (let x = 0; x < cw; x++) {
			if (!mask[y * cw + x]) continue;
			for (
				let j = Math.max(0, y - cells);
				j <= Math.min(ch - 1, y + cells);
				j++
			)
				for (
					let i = Math.max(0, x - cells);
					i <= Math.min(cw - 1, x + cells);
					i++
				)
					out[j * cw + i] = 1;
		}
	return out;
}

/**
 * Content regions inside a whole-screen change: per transition between rest states, the cells whose content
 * changed in place outside the travelling element; nearby pieces join, and each region keeps the frame where most
 * of its content shows.
 */
export function stillContent(
	transitions: Transition[],
	area: Rect,
	frame: Rect,
): ContentRect[] {
	const cw = Math.floor(frame.w / CELL);
	const ch = Math.floor(frame.h / CELL);
	const shows = new Int32Array(cw * ch).fill(-1);
	// Without travel the element cannot be told apart from what it reveals.
	for (const t of transitions)
		if (t.travel)
			markTransition({ ...t, travel: t.travel }, area, frame, cw, ch, shows);
	const mask = Uint8Array.from(shows, (k) => (k >= 0 ? 1 : 0));
	const joined = grow(mask, cw, ch, Math.round(JOIN / 2 / CELL));
	const out: ContentRect[] = [];
	for (const c of components(joined, cw, ch, 1)) {
		const votes = new Map<number, number>();
		let [x0, y0, x1, y1] = [cw, ch, -1, -1];
		for (let y = c.y; y < c.y + c.h; y++)
			for (let x = c.x; x < c.x + c.w; x++) {
				const k = shows[y * cw + x] as number;
				if (k < 0) continue;
				votes.set(k, (votes.get(k) ?? 0) + 1);
				[x0, y0, x1, y1] = [
					Math.min(x0, x),
					Math.min(y0, y),
					Math.max(x1, x),
					Math.max(y1, y),
				];
			}
		const cells = [...votes.values()].reduce((a, v) => a + v, 0);
		if (cells < MIN_CELLS) continue;
		const at = [...votes].reduce((a, v) => (v[1] > a[1] ? v : a))[0];
		const x = Math.max(frame.x, x0 * CELL - PAD);
		const y = Math.max(frame.y, y0 * CELL - PAD);
		out.push({
			x,
			y,
			w: Math.min(frame.x + frame.w, (x1 + 1) * CELL + PAD) - x,
			h: Math.min(frame.y + frame.h, (y1 + 1) * CELL + PAD) - y,
			at,
		});
	}
	return out;
}
