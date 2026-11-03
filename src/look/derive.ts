import { deltaEHex, isOpaque } from "./colour.ts";
import type {
	Box,
	FracBox,
	PageStyles,
	PixelLook,
	StyleEntry,
	Swatch,
} from "./schema.ts";
import { stylePalette, styleTextColours, textEntries } from "./summary.ts";

/** The captured area in CSS px. */
export interface Screen {
	x: number;
	y: number;
	w: number;
	h: number;
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

export const fracOf = (b: Box, s: Screen): FracBox => ({
	x: r4((b.x - s.x) / s.w),
	y: r4((b.y - s.y) / s.h),
	w: r4(b.w / s.w),
	h: r4(b.h / s.h),
});

// Colours closer than this are the same colour drawn twice.
const SAME = 2;
// Surfaces smaller than this share of the screen are detail, not design colours.
const MIN_ACCENT = 0.002;
const MAX_ACCENTS = 3;

/** The text colour with the most characters. */
export const mainTextColour = (styles: PageStyles): string | null =>
	styleTextColours(styles)[0]?.hex ?? null;

/** The largest type on the page. */
export function titleEntry(styles: PageStyles): StyleEntry | null {
	let best: StyleEntry | null = null;
	for (const e of textEntries(styles))
		if (!best || e.fontSize > best.fontSize) best = e;
	return best;
}

/** The font size with the most characters, and its most common example. */
export function bodyEntry(styles: PageStyles): StyleEntry | null {
	const chars = new Map<number, number>();
	for (const e of textEntries(styles))
		chars.set(e.fontSize, (chars.get(e.fontSize) ?? 0) + e.textLength);
	const size = [...chars].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
	return textEntries(styles).find((e) => e.fontSize === size) ?? null;
}

const accents = (list: Swatch[], background: string): Swatch[] =>
	list
		.filter((s) => s.share >= MIN_ACCENT && deltaEHex(s.hex, background) > SAME)
		.slice(0, MAX_ACCENTS);

/** Background colours other than the page's, by the area they show. */
export const styleAccents = (styles: PageStyles, screen: Screen) =>
	accents(stylePalette(styles, screen), styles.background);

/** Flat surface colours other than the frame background, by area. */
export const pixelAccents = (p: PixelLook) => accents(p.surfaces, p.background);

/** Every colour a clone shows as a surface, for matching an accent. */
export const styleSurfaceColours = (styles: PageStyles): string[] => [
	styles.background,
	...styles.elements
		.filter((e) => isOpaque(e.background))
		.map((e) => e.background.slice(0, 7)),
];

export interface StyleBlock {
	box: FracBox;
	hex: string;
	/** Index into the style dump. */
	index: number;
}

// A block covers at least this share of the screen.
const MIN_BLOCK = 0.005;
const MAX_BLOCKS = 8;

/** Elements whose own background stands out from what lies behind them, largest first. */
export function styleBlocks(
	styles: PageStyles,
	screen: Screen,
	skip: ReadonlySet<number> = new Set(),
): StyleBlock[] {
	const els = styles.elements;
	return els
		.flatMap((e, index) => {
			if (skip.has(index) || !isOpaque(e.background)) return [];
			const behind =
				e.parent >= 0
					? (els[e.parent] as StyleEntry).effectiveBackground
					: styles.background;
			const box = fracOf(e.box, screen);
			if (box.w * box.h < MIN_BLOCK || box.w * box.h > 0.9) return [];
			if (deltaEHex(e.background.slice(0, 7), behind) <= SAME) return [];
			return [{ box, hex: e.background.slice(0, 7), index }];
		})
		.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
		.slice(0, MAX_BLOCKS);
}

/** Index of a tracked element in the style dump, -1 when it is not there. */
export const trackedEntry = (
	styles: PageStyles,
	selector: string,
	index: number,
): number => styles.tracked[selector]?.[index] ?? -1;

/** Intersection over union of two boxes. */
export function iou(a: FracBox, b: FracBox): number {
	const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	if (w <= 0 || h <= 0) return 0;
	const i = w * h;
	return i / (a.w * a.h + b.w * b.h - i);
}
