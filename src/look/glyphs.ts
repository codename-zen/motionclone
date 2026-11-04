import type { PNG } from "pngjs";
import type { CellRect } from "./blocks.ts";
import { type CapHeight, capHeight, poolWeak } from "./cap-height.ts";
import { distances, flood } from "./glyph-pixels.ts";
import { isRuledWord } from "./rules.ts";
import {
	evenHeights,
	type Glyph,
	heightOf,
	MIN_GLYPHS,
	median,
	runsOf,
} from "./runs.ts";

/** One text line read from pixels, in frame pixels. */
export interface TextLine {
	x0: number;
	x1: number;
	/** Baseline minus the cap height, sub-pixel. */
	top: number;
	/** Bottom edge of the glyphs that sit on the line (their median), descenders left out, sub-pixel. */
	baseline: number;
	basis: CapHeight["basis"];
	/** Glyphs the cap height is the median of. */
	glyphs: number;
	/** Most common letter height, frame px. */
	x: number;
}

// Pixels this far from the band's background (largest channel difference) may be ink.
const MIN_INK = 24;
// A glyph's edges are where its ink reaches this share of its own contrast, so blur and antialiasing cancel out.
const EDGE_SHARE = 0.5;
// Glyphs whose bottoms lie this close (frame px) sit on one baseline; round letters overshoot it a little.
const BASELINE_PX = 1;
const MIN_CAP_PX = 4;
// Glyphs on a baseline under this share of the median letter are dots and commas; over ICON times it, icons.
const SMALL = 0.5;
const ICON = 1.6;
// A glyph this many times wider than tall is a rule or a dash, not a letter.
const RULE_WIDTH = 4;
// Ink filling this share of a nearly square glyph's box makes it a dot: letters have holes, stems or bowls.
const DOT_FILL = 0.8;

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
			// Ink across the top fifth of the glyph: wide for capitals, a stem for t and ascenders.
			const topRows = g.top + Math.max(1, Math.round(0.2 * (g.bottom - g.top)));
			let tx0 = g.x1;
			let tx1 = g.x0;
			for (const k of part) {
				const x = k % w;
				if ((k - x) / w >= topRows) continue;
				tx0 = Math.min(tx0, x);
				tx1 = Math.max(tx1, x + 1);
			}
			const box = (g.x1 - g.x0) * (g.bottom - g.top);
			const aspect = (g.x1 - g.x0) / (g.bottom - g.top);
			out.push({
				...g,
				dot: part.length >= DOT_FILL * box && aspect >= 0.6 && aspect <= 1.6,
				topWidth: (tx1 - tx0) / (g.x1 - g.x0),
				topEdge: g.top + 0.5 - edge(g.top, g.top - 1),
				bottomEdge: g.bottom - 0.5 + edge(g.bottom - 1, g.bottom),
			});
		}
	}
	return out;
}

/** Lines of glyphs that share a baseline, the most crowded baseline first. */
// `even`: only lines whose letters all have one height (a row of numbers), for glyphs pooled across bands.
function linesOf(
	glyphs: Glyph[],
	leftover: Glyph[] = [],
	even = false,
): TextLine[] {
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
			const line =
				even && !evenHeights(lettersOf(run.on))
					? null
					: lineOf(run.on, run.off);
			if (line) out.push(line);
		}
		left = left.filter((g) => !taken.includes(g));
	}
	leftover.push(...left);
	return out;
}

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

// `off` holds the glyphs across the line that do not sit on its baseline: descenders, commas, icons.
function lineOf(run: Glyph[], off: Glyph[]): TextLine | null {
	const letters = lettersOf(run);
	if (letters.length < MIN_GLYPHS) return null;
	const baseline = median(letters.map((g) => g.bottomEdge));
	const descenders = off
		.filter((g) => g.bottomEdge > baseline + BASELINE_PX && !g.dot)
		.map((g) => baseline - g.topEdge);
	const lead = letters.reduce((a, g) => (g.x0 < a.x0 ? g : a));
	const cap = capHeight(
		letters.map((g) => ({
			first: g === lead,
			height: baseline - g.topEdge,
			aspect: (g.x1 - g.x0) / heightOf(g),
			topWidth: g.topWidth,
		})),
		descenders,
	);
	return cap && cap.cap >= MIN_CAP_PX
		? {
				x0: Math.min(...letters.map((g) => g.x0)),
				x1: Math.max(...letters.map((g) => g.x1)),
				top: baseline - cap.cap,
				baseline,
				basis: cap.basis,
				glyphs: cap.glyphs,
				x: cap.x,
			}
		: null;
}

const shifted = (g: Glyph, dx: number, dy: number): Glyph => ({
	...g,
	x0: g.x0 + dx,
	x1: g.x1 + dx,
	top: g.top + dy,
	bottom: g.bottom + dy,
	topEdge: g.topEdge + dy,
	bottomEdge: g.bottomEdge + dy,
});

/** Text lines inside bands of ink cells, read at full frame resolution. */
export function textLines(
	png: PNG,
	bands: readonly CellRect[],
	cell: number,
): TextLine[] {
	const leftover: Glyph[] = [];
	const lines = bands.flatMap((band) => {
		const x0 = Math.max(0, (band.x - 1) * cell);
		const x1 = Math.min(png.width, (band.x + band.w + 1) * cell);
		const y0 = Math.max(0, (band.y - 1) * cell);
		const y1 = Math.min(png.height, (band.y + band.h + 1) * cell);
		if (x1 <= x0 || y1 <= y0) return [];
		const w = x1 - x0;
		const glyphs = glyphsOf(distances(png, x0, y0, x1, y1), w, y1 - y0);
		const left: Glyph[] = [];
		const found = linesOf(glyphs, left);
		leftover.push(...left.map((g) => shifted(g, x0, y0)));
		return found.map((l) => ({
			...l,
			x0: x0 + l.x0,
			x1: x0 + l.x1,
			top: y0 + l.top,
			baseline: y0 + l.baseline,
			cap: l.baseline - l.top,
		}));
	});
	// Glyphs left over in several bands can still share a baseline: a row of dates, one or two digits a band.
	const across = linesOf(leftover, [], true).map((l) => ({
		...l,
		cap: l.baseline - l.top,
	}));
	return poolWeak([...lines, ...across]).map(({ cap, ...l }) => ({
		...l,
		top: l.baseline - cap,
	}));
}
