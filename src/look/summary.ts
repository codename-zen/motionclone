import { isOpaque } from "./colour.ts";
import type {
	Block,
	Box,
	DesignSummary,
	PageStyles,
	PixelLook,
	StyleEntry,
	Swatch,
} from "./schema.ts";

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function clipArea(b: Box, screen: Box): number {
	const w = Math.min(b.x + b.w, screen.x + screen.w) - Math.max(b.x, screen.x);
	const h = Math.min(b.y + b.h, screen.y + screen.h) - Math.max(b.y, screen.y);
	return Math.max(0, w) * Math.max(0, h);
}

const swatches = (weights: Map<string, number>, total: number): Swatch[] =>
	[...weights]
		.filter(([, w]) => w > 0)
		.map(([hex, w]) => ({ hex, share: r3(w / total) }))
		.filter((s) => s.share > 0)
		.sort((a, b) => b.share - a.share);

const add = (m: Map<string, number>, k: string, v: number) =>
	m.set(k, (m.get(k) ?? 0) + v);

/** Nearest ancestor with an opaque background, -1 for the page. */
function surfaceOf(els: StyleEntry[], i: number): number {
	for (let p = els[i]?.parent ?? -1; p >= 0; p = els[p]?.parent ?? -1)
		if (isOpaque((els[p] as StyleEntry).background)) return p;
	return -1;
}

/** Background colours by the area they show: each surface minus the surfaces painted inside it. */
export function stylePalette(styles: PageStyles, screen: Box): Swatch[] {
	const els = styles.elements;
	const area = new Map<number, number>([[-1, screen.w * screen.h]]);
	for (const [i, e] of els.entries()) {
		if (!isOpaque(e.background)) continue;
		const a = clipArea(e.box, screen);
		area.set(i, (area.get(i) ?? 0) + a);
		const s = surfaceOf(els, i);
		area.set(s, (area.get(s) ?? 0) - a);
	}
	const weights = new Map<string, number>();
	for (const [i, a] of area)
		add(
			weights,
			i < 0 ? styles.background : (els[i] as StyleEntry).background.slice(0, 7),
			a,
		);
	return swatches(weights, screen.w * screen.h);
}

export const textEntries = (styles: PageStyles) =>
	styles.elements.filter((e) => e.textLength > 0);

export function styleTextColours(styles: PageStyles): Swatch[] {
	const weights = new Map<string, number>();
	let total = 0;
	for (const e of textEntries(styles)) {
		add(weights, e.color.slice(0, 7), e.textLength);
		total += e.textLength;
	}
	return total ? swatches(weights, total) : [];
}

function counts(values: number[]): { px: number; count: number }[] {
	const m = new Map<number, number>();
	for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
	return [...m]
		.map(([px, count]) => ({ px, count }))
		.sort((a, b) => b.count - a.count || b.px - a.px);
}

function typeScale(styles: PageStyles): DesignSummary["typeScale"] {
	const groups = new Map<number, StyleEntry[]>();
	for (const e of textEntries(styles)) {
		const px = Math.round(e.fontSize * 10) / 10;
		groups.set(px, [...(groups.get(px) ?? []), e]);
	}
	return [...groups]
		.map(([px, list]) => ({
			px,
			count: list.length,
			weights: [...new Set(list.map((e) => e.fontWeight))].sort(
				(a, b) => a - b,
			),
			families: [...new Set(list.map((e) => e.fontFamily))],
			examples: [
				...new Set(list.map((e) => `${e.tag} "${e.text.slice(0, 24)}"`)),
			].slice(0, 3),
		}))
		.sort((a, b) => b.px - a.px);
}

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
	Math.min(a1, b1) - Math.max(a0, b0);

/** Gaps between neighbouring boxes that face each other over at least half of the smaller one. */
export function spacingOf(groups: Box[][]): { px: number; count: number }[] {
	const gaps: number[] = [];
	for (const boxes of groups)
		for (const a of boxes) {
			let below = Number.POSITIVE_INFINITY;
			let right = Number.POSITIVE_INFINITY;
			for (const b of boxes) {
				if (b === a) continue;
				const dy = b.y - (a.y + a.h);
				if (
					dy >= 0 &&
					overlap(a.x, a.x + a.w, b.x, b.x + b.w) >= Math.min(a.w, b.w) / 2
				)
					below = Math.min(below, dy);
				const dx = b.x - (a.x + a.w);
				if (
					dx >= 0 &&
					overlap(a.y, a.y + a.h, b.y, b.y + b.h) >= Math.min(a.h, b.h) / 2
				)
					right = Math.min(right, dx);
			}
			for (const g of [below, right])
				if (Number.isFinite(g) && g > 0) gaps.push(Math.round(g));
		}
	return counts(gaps).slice(0, 8);
}

export function pageSummary(styles: PageStyles, screen: Box): DesignSummary {
	const siblings = new Map<number, Box[]>();
	for (const e of styles.elements)
		siblings.set(e.parent, [...(siblings.get(e.parent) ?? []), e.box]);
	return {
		palette: stylePalette(styles, screen),
		textColours: styleTextColours(styles),
		typeScale: typeScale(styles),
		radii: counts(
			styles.elements
				.filter((e) => e.radius > 0 && (isOpaque(e.background) || e.border))
				.map((e) => Math.round(e.radius)),
		),
		spacing: spacingOf([...siblings.values()]),
	};
}

export function pixelSummary(look: PixelLook, screen: Box): DesignSummary {
	const css = (b: Block): Box => ({
		x: b.x * screen.w,
		y: b.y * screen.h,
		w: b.w * screen.w,
		h: b.h * screen.h,
	});
	return {
		palette: look.palette,
		textColours: look.text ? [{ hex: look.text, share: 1 }] : [],
		typeScale: [],
		radii: [],
		spacing: spacingOf([look.blocks.map(css)]),
	};
}
