import { type ColourModel, colourModel } from "./colour.ts";
import type { Plane, Rgba } from "./luma.ts";
import type { Frame, Rect } from "./match.ts";
import { TemplateModel } from "./model.ts";
import { measureNoise, type Status } from "./quality.ts";
import { type NamedRect, structureInside, tighten } from "./regions.ts";
import type { RegionSample, RegionTrack } from "./samples.ts";
import type { Lock, Pose } from "./search.ts";

// Context ring around the element so a flat-coloured element still has edges to match.
export const MARGIN = 6;
// A changed-content box this close to the whole region did not tighten: the background changed too.
const UNTIGHTENED = 0.9;
// The colour box replaces such a box when it is clearly smaller.
const SMALLER = 0.8;
// Colours are used only when their box holds this share of the reference window's luma variance.
const MIN_STRUCTURE = 0.5;

export type End = "first" | "last";

export interface TrackRegionInput extends NamedRect {
	ref: "auto" | End;
}

export interface Ends {
	first: Plane;
	last: Plane;
	frames: { first: Frame; last: Frame };
	rgba: { first: Rgba; last: Rgba };
	/** A few consecutive frames at each end, for the noise estimate. */
	near: { first: Plane[]; last: Plane[] };
}

export interface State {
	region: RegionTrack;
	model: TemplateModel;
	/** Box centre in the reference frame, and its offset from the window centre that scales with the element. */
	home: { x: number; y: number };
	offset: { x: number; y: number };
	/** Where a lost element is searched again: the region plus the context ring. */
	area: Rect;
	colour: ColourModel | null;
	/** Box centre minus the colour box centre at the reference end. */
	colourOffset: { x: number; y: number };
	/** Quarter-resolution frame where the last wide search failed. */
	missed: Plane | null;
	pose: Pose;
	vel: Pose;
	prevFound: boolean;
	lock: Lock;
	noise: number;
}

export const expand = (r: Rect, m: number, p: Plane): Rect => {
	const x = Math.max(0, r.x - m);
	const y = Math.max(0, r.y - m);
	return {
		x,
		y,
		w: Math.min(p.width, r.x + r.w + m) - x,
		h: Math.min(p.height, r.y + r.h + m) - y,
	};
};

export const isFound = (st: Status) => st === "found" || st === "faint";

export const still: Pose = { cx: 0, cy: 0, s: 0, blur: 0 };

export const shiftOf = (s: State, p: Pose) => ({
	dx: p.cx + p.s * s.offset.x - s.home.x,
	dy: p.cy + p.s * s.offset.y - s.home.y,
});

const areaOf = (r: Rect) => r.w * r.h;

/**
 * The changed content in the region, and the element's colour model when its colours hold most of that content's
 * structure; the colour box becomes the element box when the whole region changed, a dimming backdrop for instance.
 */
export function elementBox(
	r: Rect,
	ref: End,
	ends: Ends,
	floor: number,
): { box: Rect; colour: ColourModel | null } {
	const tight = tighten(ends.first, ends.last, r, floor);
	const other = ref === "first" ? "last" : "first";
	const found = colourModel(ends.rgba[ref], ends.rgba[other], tight, r);
	const colour =
		found && structureInside(ends[ref], tight, found.box) >= MIN_STRUCTURE
			? found
			: null;
	const replace =
		colour &&
		areaOf(tight) >= UNTIGHTENED * areaOf(r) &&
		areaOf(colour.box) < SMALLER * areaOf(tight);
	return { box: replace ? colour.box : tight, colour };
}

export function initState(
	r: TrackRegionInput,
	ref: End,
	frames: number,
	ends: Ends,
	floor: number,
	lock: Lock,
): State {
	const { box, colour } = elementBox(r, ref, ends, floor);
	const win = expand(box, MARGIN, ends.first);
	const samples: RegionSample[] = Array.from({ length: frames }, () => ({
		found: false,
		dx: 0,
		dy: 0,
		scale: 1,
		blur: 0,
		ncc: 0,
		opacity: 0,
		quality: 0,
		status: "absent",
		method: "none",
		centroid: null,
		energy: 0,
	}));
	const home = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
	const centre = { x: win.x + win.w / 2, y: win.y + win.h / 2 };
	const cb = colour?.box ?? box;
	return {
		region: { name: r.name, box, ref, samples },
		model: new TemplateModel(ends.frames[ref], win),
		home,
		offset: { x: home.x - centre.x, y: home.y - centre.y },
		area: expand(r, MARGIN, ends.first),
		colour,
		colourOffset: { x: home.x - cb.x - cb.w / 2, y: home.y - cb.y - cb.h / 2 },
		missed: null,
		pose: { cx: centre.x, cy: centre.y, s: 1, blur: 0 },
		vel: still,
		prevFound: false,
		lock,
		noise: measureNoise(ends.near[ref], win, floor),
	};
}
