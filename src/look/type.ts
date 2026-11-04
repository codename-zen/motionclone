import type { PNG } from "pngjs";
import type { TextLine } from "./glyphs.ts";
import type { FracBox, TypeLine, TypeSize } from "./schema.ts";

export { textLines } from "./glyphs.ts";

// Lines of one size differ by under this share: glyph shapes and antialiasing.
const SAME_SIZE = 0.08;
const MAX_SIZES = 3;
// A line belongs to a box when it lies inside it, give or take this share of the screen.
const SLACK = 0.005;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** Frame-pixel lines as fractions of the frame, cap heights in CSS px. */
export const typeLines = (
	lines: readonly TextLine[],
	png: PNG,
	cssPerPx: number,
): TypeLine[] =>
	lines.map((l) => ({
		x: r4(l.x0 / png.width),
		y: r4(l.baseline / png.height),
		w: r4((l.x1 - l.x0) / png.width),
		cap: r1((l.baseline - l.top) * cssPerPx),
	}));

export const inBox = (l: TypeLine, b: FracBox) =>
	l.x >= b.x - SLACK &&
	l.x + l.w <= b.x + b.w + SLACK &&
	l.y >= b.y - SLACK &&
	l.y <= b.y + b.h + SLACK;

export interface SizeGroup {
	/** Median cap height, CSS px. */
	px: number;
	lines: TypeLine[];
	/** Share of the text's width. */
	share: number;
}

/** Lines pooled by cap height: the sizes with the most text, at most MAX_SIZES, largest first. */
export function sizeGroups(lines: readonly TypeLine[]): SizeGroup[] {
	const sorted = [...lines].sort((a, b) => a.cap - b.cap);
	const groups: TypeLine[][] = [];
	for (const l of sorted) {
		const g = groups.at(-1);
		if (g && l.cap <= (g[0] as TypeLine).cap * (1 + SAME_SIZE)) g.push(l);
		else groups.push([l]);
	}
	const width = (g: TypeLine[]) => g.reduce((s, l) => s + l.w, 0);
	const total = groups.reduce((s, g) => s + width(g), 0);
	return groups
		.sort((a, b) => width(b) - width(a))
		.slice(0, MAX_SIZES)
		.map((g) => {
			const caps = g.map((l) => l.cap).sort((a, b) => a - b);
			return {
				px: caps[caps.length >> 1] as number,
				lines: g.sort((a, b) => a.y - b.y || a.x - b.x),
				share: Math.round((width(g) / total) * 1000) / 1000,
			};
		})
		.sort((a, b) => b.px - a.px);
}

export const typeSizes = (lines: readonly TypeLine[]): TypeSize[] =>
	sizeGroups(lines).map((g) => ({
		px: g.px,
		lines: g.lines.length,
		share: g.share,
	}));

// A clone line this many reference cap heights from a reference line can still stand for it: layout moved it.
const MOVED_CAPS = 3;

const across = (a: TypeLine, b: TypeLine) => a.x < b.x + b.w && b.x < a.x + a.w;

/** The lines that overlap a line across, top to bottom: its column. */
const columnOf = (l: TypeLine, all: readonly TypeLine[]) =>
	all.filter((o) => across(o, l)).sort((a, b) => a.y - b.y);

/** A line with its place in its column: `rank` from the top among `count` lines. */
export const ranked = (l: TypeLine, all: readonly TypeLine[]): RankedLine => {
	const column = columnOf(l, all);
	return { ...l, rank: Math.max(0, column.indexOf(l)), count: column.length };
};

export type RankedLine = TypeLine & { rank: number; count: number };

/**
 * Cap heights of the clone's lines in the places of the reference's lines. A column with as many lines as the
 * reference's pairs them in order, so a line moved by a larger or smaller line above it is still found; otherwise the
 * clone line nearest the reference baseline stands for it. Either way within MOVED_CAPS cap heights.
 */
export function capsAt(
	want: readonly RankedLine[],
	got: readonly TypeLine[],
	screenHeight: number,
): number[] {
	return want.flatMap((r) => {
		const limit = (MOVED_CAPS * r.cap) / screenHeight;
		const column = columnOf(r, got);
		const paired = column.length === r.count ? column[r.rank] : undefined;
		if (paired && Math.abs(paired.y - r.y) <= limit) return [paired.cap];
		let best: TypeLine | null = null;
		let gap = limit;
		for (const c of column) {
			const d = Math.abs(c.y - r.y);
			if (d <= gap) {
				best = c;
				gap = d;
			}
		}
		return best ? [best.cap] : [];
	});
}
