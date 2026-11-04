import type { PNG } from "pngjs";
import type { CellRect } from "./blocks.ts";
import { isRuledWord } from "./rules.ts";

/** One text line read from pixels, in frame pixels. */
export interface TextLine {
	x0: number;
	x1: number;
	/** Top edge of its tallest glyph that sits on the baseline (a capital or an ascender), sub-pixel. */
	top: number;
	/** Bottom edge of the glyphs that sit on the line (their median), descenders left out, sub-pixel. */
	baseline: number;
}

interface Glyph {
	x0: number;
	x1: number;
	/** Rows of the half-contrast extent: top row and the row under the last one. */
	top: number;
	bottom: number;
	/** The same edges with sub-pixel precision, interpolated where the ink crosses half its contrast. */
	topEdge: number;
	bottomEdge: number;
	/** A solid, nearly square blob: a dot of an icon or a full stop, never a letter. */
	dot: boolean;
}

// Pixels this far from the band's background (largest channel difference) may be ink.
const MIN_INK = 24;
// A glyph's edges are where its ink reaches this share of its own contrast, so blur and antialiasing cancel out.
const EDGE_SHARE = 0.5;
// Glyphs whose bottoms lie this close (frame px) sit on one baseline; round letters overshoot it a little.
const BASELINE_PX = 1;
// A line has at least this many glyphs on its baseline; icons and rules stand alone.
const MIN_GLYPHS = 3;
const MIN_CAP_PX = 4;
// Glyphs on a baseline under this share of the median letter are dots and commas; over ICON times it, icons.
const SMALL = 0.5;
const ICON = 1.6;
// A glyph this many times wider than tall is a rule or a dash, not a letter.
const RULE_WIDTH = 4;
// Ink filling this share of a nearly square glyph's box makes it a dot: letters have holes, stems or bowls.
const DOT_FILL = 0.8;
// Glyphs of one line further apart than this many cap heights are separate lines, such as text in two cards.
const WORD_GAP = 1.5;

/** Largest channel difference of each pixel from the most common colour of the rectangle. */
function distances(png: PNG, x0: number, y0: number, x1: number, y1: number) {
	const w = x1 - x0;
	const px = (x: number, y: number) => (y * png.width + x) * 4;
	const bins = new Map<number, number>();
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const p = px(x, y);
			const key =
				((png.data[p] as number) >> 4) * 256 +
				((png.data[p + 1] as number) >> 4) * 16 +
				((png.data[p + 2] as number) >> 4);
			bins.set(key, (bins.get(key) ?? 0) + 1);
		}
	let key = 0;
	let most = -1;
	for (const [k, n] of bins)
		if (n > most) {
			most = n;
			key = k;
		}
	const bg = [key >> 8, (key >> 4) & 15, key & 15].map((v) => v * 16 + 8);
	const d = new Float32Array(w * (y1 - y0));
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const p = px(x, y);
			let m = 0;
			for (let c = 0; c < 3; c++)
				m = Math.max(
					m,
					Math.abs((png.data[p + c] as number) - (bg[c] as number)),
				);
			d[(y - y0) * w + x - x0] = m;
		}
	return d;
}

/** Pixels connected to `start` that pass `ok`, marking each in `mark`; diagonal neighbours count when `diagonal`. */
function flood(
	start: number,
	w: number,
	h: number,
	ok: (j: number) => boolean,
	mark: Uint8Array,
	diagonal: boolean,
): number[] {
	const stack = [start];
	const pixels: number[] = [];
	mark[start] = 1;
	while (stack.length) {
		const i = stack.pop() as number;
		pixels.push(i);
		const x = i % w;
		const y = (i - x) / w;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				if ((dx === 0 && dy === 0) || (!diagonal && dx !== 0 && dy !== 0))
					continue;
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
				const j = ny * w + nx;
				if (!mark[j] && ok(j)) {
					mark[j] = 1;
					stack.push(j);
				}
			}
	}
	return pixels;
}

/**
 * Glyphs with their half-contrast extents, in rectangle coordinates. Ink is joined at a low level first, then split
 * where it stays under half its contrast, so letters that touch only through antialiasing come apart.
 */
function glyphsOf(d: Float32Array, w: number, h: number): Glyph[] {
	const seen = new Uint8Array(w * h);
	const core = new Uint8Array(w * h);
	const owner = new Int32Array(w * h).fill(-1);
	const out: Glyph[] = [];
	const at = (x: number, y: number) =>
		y < 0 || y >= h ? 0 : (d[y * w + x] as number);
	for (let start = 0; start < w * h; start++) {
		if (seen[start] || (d[start] as number) < MIN_INK) continue;
		const ink = flood(
			start,
			w,
			h,
			(j) => (d[j] as number) >= MIN_INK,
			seen,
			true,
		);
		let max = 0;
		for (const i of ink) {
			max = Math.max(max, d[i] as number);
			owner[i] = start;
		}
		const half = EDGE_SHARE * max;
		for (const i of ink) {
			if (core[i] || (d[i] as number) < half) continue;
			const part = flood(
				i,
				w,
				h,
				(j) => owner[j] === start && (d[j] as number) >= half,
				core,
				false,
			);
			if (isRuledWord(part, w)) continue;
			const g = { x0: w, x1: -1, top: h, bottom: -1 };
			for (const k of part) {
				const x = k % w;
				const y = (k - x) / w;
				g.x0 = Math.min(g.x0, x);
				g.x1 = Math.max(g.x1, x + 1);
				g.top = Math.min(g.top, y);
				g.bottom = Math.max(g.bottom, y + 1);
			}
			if (g.bottom - g.top < 2) continue;
			const edge = (row: number, outside: number) => {
				let col = g.x0;
				for (let x = g.x0; x < g.x1; x++)
					if (at(x, row) > at(col, row)) col = x;
				const inner = at(col, row);
				const outer = Math.min(at(col, outside), inner);
				return inner > outer ? (inner - half) / (inner - outer) : 0;
			};
			const box = (g.x1 - g.x0) * (g.bottom - g.top);
			const aspect = (g.x1 - g.x0) / (g.bottom - g.top);
			out.push({
				...g,
				dot: part.length >= DOT_FILL * box && aspect >= 0.6 && aspect <= 1.6,
				topEdge: g.top + 0.5 - edge(g.top, g.top - 1),
				bottomEdge: g.bottom - 0.5 + edge(g.bottom - 1, g.bottom),
			});
		}
	}
	return out;
}

/** Lines of glyphs that share a baseline, the most crowded baseline first. */
function linesOf(glyphs: Glyph[]): TextLine[] {
	const out: TextLine[] = [];
	let left = glyphs;
	while (left.length >= MIN_GLYPHS) {
		const counts = new Map<number, number>();
		for (const g of left)
			for (let b = g.bottom - BASELINE_PX; b <= g.bottom + BASELINE_PX; b++)
				counts.set(b, (counts.get(b) ?? 0) + 1);
		let base = 0;
		let most = 0;
		for (const [b, n] of counts)
			if (n > most || (n === most && b > base)) {
				most = n;
				base = b;
			}
		const on = left.filter((g) => Math.abs(g.bottom - base) <= BASELINE_PX);
		if (on.length < MIN_GLYPHS) break;
		const top = Math.min(...on.map((g) => g.top));
		const x0 = Math.min(...on.map((g) => g.x0));
		const x1 = Math.max(...on.map((g) => g.x1));
		// Descenders, commas and icons across the line belong to it, not to a line of their own.
		const taken = left.filter(
			(g) =>
				on.includes(g) ||
				(g.top < base && g.bottom > top && g.x1 > x0 && g.x0 < x1),
		);
		for (const run of runsOf(taken, on, base - top)) {
			const line = lineOf(run);
			if (line) out.push(line);
		}
		left = left.filter((g) => !taken.includes(g));
	}
	return out;
}

// Glyphs on one baseline, split where neighbours are further apart than WORD_GAP cap heights: columns, cards.
// Descenders across the line (`taken`) close gaps too, so a word like "fy" does not split its line.
function runsOf(taken: Glyph[], on: Glyph[], cap: number): Glyph[][] {
	const sorted = [...taken].sort((a, b) => a.x0 - b.x0);
	const runs: Glyph[][] = [];
	let end = Number.NEGATIVE_INFINITY;
	for (const g of sorted) {
		const run = runs.at(-1);
		if (run && g.x0 - end <= WORD_GAP * cap) run.push(g);
		else runs.push([g]);
		end = Math.max(end, g.x1);
	}
	return runs
		.map((r) => r.filter((g) => on.includes(g)))
		.filter((r) => r.length >= MIN_GLYPHS);
}

const heightOf = (g: Glyph) => g.bottomEdge - g.topEdge;
const median = (v: number[]) =>
	[...v].sort((a, b) => a - b)[v.length >> 1] as number;

/**
 * The letters of a run: glyphs at least MIN_CAP_PX tall, without rules, solid dots and other small blobs on the baseline, and
 * without icons taller than ICON times the median letter.
 */
function lettersOf(run: Glyph[]): Glyph[] {
	const sized = run.filter(
		(g) =>
			!g.dot &&
			heightOf(g) >= MIN_CAP_PX &&
			g.x1 - g.x0 <= RULE_WIDTH * heightOf(g),
	);
	if (sized.length < MIN_GLYPHS) return [];
	const m = median(sized.map(heightOf));
	return sized.filter(
		(g) => heightOf(g) >= SMALL * m && heightOf(g) <= ICON * m,
	);
}

function lineOf(run: Glyph[]): TextLine | null {
	const letters = lettersOf(run);
	if (letters.length < MIN_GLYPHS) return null;
	const baseline = median(letters.map((g) => g.bottomEdge));
	const top = Math.min(...letters.map((g) => g.topEdge));
	return baseline - top >= MIN_CAP_PX
		? {
				x0: Math.min(...letters.map((g) => g.x0)),
				x1: Math.max(...letters.map((g) => g.x1)),
				top,
				baseline,
			}
		: null;
}

/** Text lines inside bands of ink cells, read at full frame resolution. */
export function textLines(
	png: PNG,
	bands: readonly CellRect[],
	cell: number,
): TextLine[] {
	return bands.flatMap((band) => {
		const x0 = Math.max(0, (band.x - 1) * cell);
		const x1 = Math.min(png.width, (band.x + band.w + 1) * cell);
		const y0 = Math.max(0, (band.y - 1) * cell);
		const y1 = Math.min(png.height, (band.y + band.h + 1) * cell);
		if (x1 <= x0 || y1 <= y0) return [];
		const w = x1 - x0;
		const glyphs = glyphsOf(distances(png, x0, y0, x1, y1), w, y1 - y0);
		return linesOf(glyphs).map((l) => ({
			x0: x0 + l.x0,
			x1: x0 + l.x1,
			top: y0 + l.top,
			baseline: y0 + l.baseline,
		}));
	});
}
