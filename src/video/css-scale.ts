// CSS widths of common phones.
export const PHONE_WIDTHS = [360, 375, 390, 393, 402, 412, 414, 428, 430, 440];
const RATIOS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4];
const MIN_CSS = 320;
const MAX_CSS = 480;

export interface CssScaleGuess {
	cssScale: number;
	/** Screen width in CSS pixels at that scale. */
	cssWidth: number;
	/** The common phone width closest to cssWidth. */
	nearest: number;
}

/**
 * Video pixels per CSS pixel for a phone screen `width` video pixels wide: the round ratio whose CSS width lands
 * closest to a common phone width. Ties go to the rounder ratio. Null when no ratio gives a phone width.
 */
export function guessCssScale(width: number): CssScaleGuess | null {
	let best: CssScaleGuess | null = null;
	let bestGap = Infinity;
	for (const cssScale of RATIOS) {
		const cssWidth = width / cssScale;
		if (cssWidth < MIN_CSS || cssWidth > MAX_CSS) continue;
		const nearest = PHONE_WIDTHS.reduce((p, q) =>
			Math.abs(q - cssWidth) < Math.abs(p - cssWidth) ? q : p,
		);
		const gap =
			Math.abs(nearest - cssWidth) + (Number.isInteger(cssScale) ? 0 : 0.5);
		if (gap < bestGap) {
			bestGap = gap;
			best = { cssScale, cssWidth: Math.round(cssWidth), nearest };
		}
	}
	return best;
}
