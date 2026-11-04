/** One connected glyph with its half-contrast extents, in rectangle coordinates. */
export interface Glyph {
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
	/** Share of its width the ink covers in its top rows. */
	topWidth: number;
}

// A line has at least this many glyphs on its baseline; icons and rules stand alone.
export const MIN_GLYPHS = 3;
// Glyphs of one line further apart than this many cap heights are separate lines, such as text in two cards.
const WORD_GAP = 1.5;

export const heightOf = (g: Glyph) => g.bottomEdge - g.topEdge;
export const median = (v: number[]) =>
	[...v].sort((a, b) => a - b)[v.length >> 1] as number;

// Glyphs on one baseline, split where neighbours are further apart than WORD_GAP cap heights: columns, cards.
// Descenders across the line (`taken`) close gaps too, so a word like "fy" does not split its line.
export function runsOf(
	taken: Glyph[],
	on: Glyph[],
	cap: number,
): { on: Glyph[]; off: Glyph[] }[] {
	const sorted = [...taken].sort((a, b) => a.x0 - b.x0);
	const runs: Glyph[][] = [];
	let end = Number.NEGATIVE_INFINITY;
	for (const g of sorted) {
		const run = runs.at(-1);
		if (run && g.x0 - end <= WORD_GAP * cap) run.push(g);
		else runs.push([g]);
		end = Math.max(end, g.x1);
	}
	const split = runs.map((r) => ({
		on: r.filter((g) => on.includes(g)),
		off: r.filter((g) => !on.includes(g)),
	}));
	return joinShort(split).filter((r) => r.on.length >= MIN_GLYPHS);
}

type Run = { on: Glyph[]; off: Glyph[] };

/**
 * Neighbouring runs too short for a line (a row of dates "6 7 8 9", one or two glyphs a word) joined into one,
 * as long as their glyphs on the baseline are of one height: a row of numbers, not a word beside an icon.
 */
function joinShort(runs: Run[]): Run[] {
	const out: Run[] = [];
	let pending: Run[] = [];
	const flush = () => {
		const on = pending.flatMap((r) => r.on);
		if (pending.length > 1 && on.length >= MIN_GLYPHS && evenHeights(on))
			out.push({ on, off: pending.flatMap((r) => r.off) });
		else out.push(...pending);
		pending = [];
	};
	for (const r of runs) {
		const last = pending.at(-1)?.on;
		const h = Math.max(...[...r.on, ...(last ?? [])].map(heightOf));
		const gap = last
			? Math.min(...r.on.map((g) => g.x0)) - Math.max(...last.map((g) => g.x1))
			: 0;
		if (r.on.length >= MIN_GLYPHS || gap > JOIN_GAP * h) flush();
		if (r.on.length >= MIN_GLYPHS) out.push(r);
		else pending.push(r);
	}
	flush();
	return out;
}

// Short runs further apart than this many glyph heights are not one row.
const JOIN_GAP = 6;
// Glyphs of one height differ by under this share of their median.
const EVEN = 0.06;
// Most of them must share it: thin digits can break into pieces at half contrast, a pair of words mostly does not.
const EVEN_SHARE = 0.6;

/** Whether most glyphs (not dots) have one height, at least MIN_GLYPHS of them. */
export function evenHeights(glyphs: Glyph[]): boolean {
	const all = glyphs.filter((g) => !g.dot).map(heightOf);
	// Pieces under half the tallest glyph are dots and fragments, not letters of another height.
	const hs = all.filter((h) => h >= 0.5 * Math.max(...all));
	const most = Math.max(
		0,
		...hs.map((h) => hs.filter((o) => Math.abs(o - h) <= EVEN * h).length),
	);
	return most >= MIN_GLYPHS && most >= EVEN_SHARE * hs.length;
}
