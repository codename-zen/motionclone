import {
	boxOf,
	CELL,
	type ColourReading,
	countIn,
	distance,
	dominant,
	looseBox,
	lutOf,
	MATCH,
	maskOf,
	type Rgb,
} from "./colour-mask.ts";
import type { Rgba } from "./luma.ts";
import type { Rect } from "./match.ts";

export type { ColourReading } from "./colour-mask.ts";

// A colour is rare when this share of the pixels it is looked for in at most lies within 1.5x the match distance.
const RARE_DIST = 42;
const MAX_OTHER = 0.005;
// At least this share of a set colour's pixels lies inside the element's box, so background colours drop out.
const INSIDE = 0.8;
// The element is mostly made of its set colours.
const MIN_FILL = 0.5;
// Per frame: fill against the reference and aspect change under which the box is the element, uniformly scaled.
const MIN_FILL_RATIO = 0.6;
const MAX_ASPECT = 0.1;

/** Colours that mark one element, and its box at the reference end. */
export interface ColourModel {
	lut: Uint8Array;
	/** Where the element is looked for: the region, frame pixels. */
	area: Rect;
	box: Rect;
	/** Share of the box made of set colours. */
	fill: number;
	/** The element's box at the other end when it is there too (a persistent element), else null. */
	otherBox: Rect | null;
}

const areaOf = (r: Rect) => r.w * r.h;

const clip = (r: Rect, a: Rect): Rect => {
	const x = Math.max(r.x, a.x);
	const y = Math.max(r.y, a.y);
	return {
		x,
		y,
		w: Math.max(0, Math.min(r.x + r.w, a.x + a.w) - x),
		h: Math.max(0, Math.min(r.y + r.h, a.y + a.h) - y),
	};
};

const shareIn = (p: Rgba, a: Rect, c: Rgb) =>
	countIn(p, a, c, RARE_DIST, null).all / areaOf(a);

function purity(p: Rgba, a: Rect, c: Rgb, box: Rect): number {
	const { all, inBox } = countIn(p, a, c, MATCH, box);
	return all ? inBox / all : 0;
}

/** Share of the area outside the box (one cell around it included in the box) that lies near the colour. */
function outsideShare(p: Rgba, a: Rect, c: Rgb, box: Rect): number {
	const g = clip(
		{
			x: box.x - CELL,
			y: box.y - CELL,
			w: box.w + 2 * CELL,
			h: box.h + 2 * CELL,
		},
		a,
	);
	const rest = areaOf(a) - areaOf(g);
	if (rest <= 0) return 1;
	const { all, inBox } = countIn(p, a, c, RARE_DIST, g);
	return (all - inBox) / rest;
}

const readAt = (p: Rgba, colours: Rgb[], a: Rect) =>
	boxOf(maskOf(p, lutOf(colours, MATCH), a), a);

/** A box that reaches every side of the area is the background around something, not an element. */
const spans = (b: Rect, a: Rect) =>
	b.x - a.x < CELL &&
	b.y - a.y < CELL &&
	a.x + a.w - b.x - b.w < CELL &&
	a.y + a.h - b.y - b.h < CELL;

const aspectGap = (a: Rect, b: Rect) =>
	Math.abs(Math.log(a.w / a.h / (b.w / b.h)));

/** Content swap: the colours are rare in the whole region at the other end. */
export function swapModel(
	ref: Rgba,
	other: Rgba,
	win: Rect,
	area: Rect,
): ColourModel | null {
	const all = dominant(ref, win);
	const rare = all.map((c) => shareIn(other, area, c) <= MAX_OTHER);
	// A colour near the background of the reference end would match that background too.
	const background = all.filter((_, i) => !rare[i]);
	let colours = all.filter(
		(c, i) => rare[i] && background.every((d) => distance(c, d) > RARE_DIST),
	);
	if (colours.length === 0) return null;
	const first = readAt(ref, colours, area);
	if (!first) return null;
	colours = colours.filter((c) => purity(ref, area, c, first.box) >= INSIDE);
	if (colours.length === 0) return null;
	const at = readAt(ref, colours, area);
	if (!at || at.fill < MIN_FILL) return null;
	return {
		lut: lutOf(colours, MATCH),
		area,
		box: at.box,
		fill: at.fill,
		otherBox: null,
	};
}

/**
 * Persistent element: at both ends the colours form one compact patch and are rare in the rest of the region,
 * whatever its size and place; colours that only fill part of it (a pattern) join once that patch is known.
 * Callers still have to check that the element stays visible between the ends (see colour-continuity.ts).
 */
export function persistentModel(
	ref: Rgba,
	other: Rgba,
	win: Rect,
	area: Rect,
): ColourModel | null {
	const ends = [ref, other];
	const all = dominant(ref, win);
	const alone = all.filter((c) =>
		ends.every((p) => {
			const b = looseBox(p, lutOf([c], MATCH), area);
			return b !== null && outsideShare(p, area, c, b) <= MAX_OTHER;
		}),
	);
	if (alone.length === 0) return null;
	const boxes = ends.map((p) => looseBox(p, lutOf(alone, MATCH), area));
	if (!boxes[0] || !boxes[1]) return null;
	const kept = all.filter(
		(c) =>
			alone.includes(c) ||
			(purity(ref, area, c, boxes[0] as Rect) >= INSIDE &&
				ends.every(
					(p, i) => outsideShare(p, area, c, boxes[i] as Rect) <= MAX_OTHER,
				)),
	);
	const background = all.filter((c) => !kept.includes(c));
	const colours = kept.filter((c) =>
		background.every((d) => distance(c, d) > RARE_DIST),
	);
	if (colours.length === 0) return null;
	const [at, to] = ends.map((p) => readAt(p, colours, area));
	if (!at || !to || at.fill < MIN_FILL || to.fill < MIN_FILL) return null;
	if (spans(at.box, area) || spans(to.box, area)) return null;
	if (aspectGap(at.box, to.box) > MAX_ASPECT) return null;
	return {
		lut: lutOf(colours, MATCH),
		area,
		box: at.box,
		fill: at.fill,
		otherBox: to.box,
	};
}

/** The element's box in a frame, or null when its colours do not form a uniformly scaled copy of it. */
export function readColour(m: ColourModel, p: Rgba): ColourReading | null {
	const r = boxOf(maskOf(p, m.lut, m.area), m.area);
	if (!r || r.fill < MIN_FILL_RATIO * m.fill) return null;
	const aspect = Math.log(r.box.w / r.box.h / (m.box.w / m.box.h));
	return Math.abs(aspect) <= MAX_ASPECT ? r : null;
}

/** Scale against the reference box and centre of a reading, frame pixels. */
export function poseOf(m: ColourModel, r: ColourReading) {
	return {
		s: Math.sqrt((r.box.w * r.box.h) / (m.box.w * m.box.h)),
		x: r.box.x + r.box.w / 2,
		y: r.box.y + r.box.h / 2,
	};
}
