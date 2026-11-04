/** Cap height of one text line and what it was read from. */
export interface CapHeight {
	/** Frame px from the baseline. */
	cap: number;
	/** `capitals`: capitals or digits; `ascenders`: no capital stood out; `x-height`: lowercase only, scaled by X_PER_CAP. */
	basis: "capitals" | "ascenders" | "x-height";
	/** Glyphs the height is the median of. */
	glyphs: number;
	/** The most common letter height, frame px: the x-height, or the cap height of a line in capitals. */
	x: number;
}

export interface Letter {
	/** Frame px from the baseline to its top edge. */
	height: number;
	/** Width per height. */
	aspect: number;
	/** Share of its width its ink covers in its top rows. */
	topWidth: number;
	/** The line's first letter, which is most often a capital. */
	first?: boolean;
}

// Heights further apart than this share (and SPLIT_PX) are different glyph classes: x-height, t, capitals, ascenders.
const SPLIT = 0.035;
const SPLIT_PX = 0.35;
// A letter this much taller than the x-height stands over it: t, capitals, ascenders.
const TALL = 1.15;
// Capitals are wide at the top (E, H, T, M, 7); t and the ascenders of b, d, h, k only have a stem there.
const CAPITAL_TOP = 0.6;
// A first letter this much over the x-height is a capital even when round (C, S, O); a t stays under it.
const FIRST_CAPITAL = 1.25;
// Capitals and digits of one size differ by up to this share under hinting (9 to 9.8 px digits at 14 px).
const CAPS_SPLIT = 0.05;
// Capitals reach 0.91 to 0.95 of the ascenders, t 0.81 to 0.88 (Segoe UI, Georgia, Liberation Serif).
const T_UNDER = 0.895;
// Narrow letters tell nothing from their top: stems (l, I, 1), a serif l, and a t whose top fills its narrow box.
const STEM = 0.36;
// x-height per cap height in common sans and serif faces (Segoe UI 0.71, Georgia 0.70, Arial 0.73).
export const X_PER_CAP = 0.71;
// A descender whose top lies this close to a class's top shows that class is lowercase.
const SAME_TOP = 0.12;

const median = (v: readonly number[]) =>
	[...v].sort((a, b) => a - b)[v.length >> 1] as number;

/** Letters split into classes of height at gaps, lowest first. */
function classes(letters: readonly Letter[], split = SPLIT): Letter[][] {
	const sorted = [...letters].sort((a, b) => a.height - b.height);
	const out: Letter[][] = [];
	for (const l of sorted) {
		const last = out.at(-1);
		const prev = last?.at(-1)?.height;
		if (
			last &&
			prev !== undefined &&
			l.height - prev <= Math.max(split * prev, SPLIT_PX)
		)
			last.push(l);
		else out.push([l]);
	}
	return out;
}

const heightOf = (c: readonly Letter[]) => median(c.map((l) => l.height));
// Hinting and blur shorten a capital or digit more often than they stretch it: a few are read at their upper
// quartile, many at their median.
const upper = (c: readonly Letter[]) =>
	c.length >= 4
		? heightOf(c)
		: ([...c.map((l) => l.height)].sort((a, b) => a - b)[
				Math.floor(0.75 * c.length)
			] as number);
const capitalLike = (l: Letter, x: number) =>
	l.aspect >= STEM &&
	(l.topWidth >= CAPITAL_TOP ||
		(l.first === true && l.height >= FIRST_CAPITAL * x));
const largest = (list: readonly Letter[][]) =>
	list.reduce<Letter[] | undefined>(
		(best, c) => (!best || c.length > best.length ? c : best),
		undefined,
	);

/**
 * Cap height from a line's letters. The most common height is the x-height, or the capitals of a line set in
 * capitals. Capitals are the letters over it that are wide at the top, which t and most ascenders are not, and a
 * tall first letter. Without them the tallest letters are read (ascenders, or capitals that blur hid). A line of
 * one height is capitals or digits, unless a descender reaches as high: then it is lowercase and its x-height is scaled.
 */
export function capHeight(
	letters: readonly Letter[],
	descenders: readonly number[],
): CapHeight | null {
	const cls = classes(letters);
	let common = largest(cls);
	// Text repeats its x-height; signal bars and other icons in a row have no common height.
	if (!common || common.length < 2) return null;
	// Capitals and digits can outnumber the lowercase ("18:30 at home"): a repeated class under them is the x-height.
	const over = (c: readonly Letter[]) =>
		letters.filter((l) => l.height >= TALL * heightOf(c));
	if (over(common).length === 0) {
		const under = largest(
			cls.filter(
				(c) =>
					c.length >= 2 && TALL * heightOf(c) <= heightOf(common as Letter[]),
			),
		);
		if (under) common = under;
	}
	const x = heightOf(common);
	const tall = over(common);
	// t stands under the capitals by more than they stand under the ascenders: under T_UNDER of the tallest letters.
	const highest = classes(tall)
		.filter((c) => c.length >= 2)
		.at(-1);
	const floor = highest ? T_UNDER * heightOf(highest) : 0;
	const wide = tall.filter((l) => l.height >= floor && capitalLike(l, x));
	// The height most wide letters share; on a tie the lower one, since ascenders stand over the capitals.
	const caps = largest(classes(wide, CAPS_SPLIT));
	if (caps)
		return { cap: upper(caps), basis: "capitals", glyphs: caps.length, x };
	// No capital stands out: the tallest letters (ascenders, or capitals that blur hides) are read instead.
	const top = classes(tall).at(-1);
	if (top)
		return { cap: heightOf(top), basis: "ascenders", glyphs: top.length, x };
	// Every letter of one height, give or take noise that splits small type into classes: all of them count.
	const one = heightOf(letters as Letter[]);
	return descenders.some((d) => Math.abs(d - one) <= SAME_TOP * one)
		? {
				cap: one / X_PER_CAP,
				basis: "x-height",
				glyphs: letters.length,
				x: one,
			}
		: { cap: one, basis: "capitals", glyphs: letters.length, x: one };
}

/** A line's cap height with the x-height it came with. */
export interface MeasuredLine {
	cap: number;
	basis: CapHeight["basis"];
	glyphs: number;
	x: number;
}

/**
 * Lines whose cap height rests on one glyph, on ascenders or on their x-height, take the median cap height of every
 * line with the same x-height: a round or hooked letter alone (C, S, f) misreads a line that its neighbours of one size
 * read right. A line left with one ascender is dropped.
 */
export function poolWeak<T extends MeasuredLine>(lines: readonly T[]): T[] {
	// Lines in capitals or digits only have no x-height of their own to share.
	const sorted = lines
		.filter((l) => l.basis !== "capitals" || l.cap > TALL * l.x)
		.sort((a, b) => a.x - b.x);
	const groups: T[][] = [];
	for (const l of sorted) {
		const g = groups.at(-1);
		const prev = g?.at(-1)?.x;
		if (
			g &&
			prev !== undefined &&
			l.x - prev <= Math.max(SPLIT * prev, SPLIT_PX)
		)
			g.push(l);
		else groups.push([l]);
	}
	const pooled = new Map<T, number>();
	for (const g of groups)
		if (g.length >= 3) {
			const cap = median(g.map((l) => l.cap));
			for (const l of g)
				if (l.glyphs < 2 || l.basis !== "capitals") pooled.set(l, cap);
		}
	// One tall glyph and no capital, with no neighbours to vouch for it, is a guess: blurred small capitals split.
	return lines.flatMap((l) => {
		const cap = pooled.get(l);
		if (cap !== undefined) return [{ ...l, cap, basis: "capitals" as const }];
		return l.basis === "ascenders" && l.glyphs < 2 ? [] : [l];
	});
}
