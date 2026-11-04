// A row of a wide glyph is a rule (strike-through, underline) where ink covers this share of its width: end to end, unlike the bar of an f or a t.
const RULE_COVER = 0.9;
// A rule is thin: at most this share of the glyph's height.
const RULE_SHARE = 0.35;
// Only glyphs this many times wider than tall can be words joined by a rule.
const WIDE = 2;

/**
 * Whether a glyph is a word joined by a strike-through or underline: wide, with a thin band of rows its ink covers
 * almost end to end. Its letters cannot be told apart, so it is no letter. Pixels index a `w`-wide rectangle.
 */
export function isRuledWord(part: readonly number[], w: number): boolean {
	const rows = new Map<number, number>();
	let x0 = w;
	let x1 = -1;
	for (const i of part) {
		const x = i % w;
		const y = (i - x) / w;
		rows.set(y, (rows.get(y) ?? 0) + 1);
		x0 = Math.min(x0, x);
		x1 = Math.max(x1, x);
	}
	const ys = [...rows.keys()];
	const width = x1 - x0 + 1;
	const height = Math.max(...ys) - Math.min(...ys) + 1;
	if (width < WIDE * height) return false;
	const covered = [...rows.values()].filter(
		(n) => n >= RULE_COVER * width,
	).length;
	return covered > 0 && covered <= RULE_SHARE * height;
}
