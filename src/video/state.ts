import type { ColourModel } from "./colour.ts";
import type { Plane, Rgba } from "./luma.ts";
import type { Frame, Rect } from "./match.ts";
import { TemplateModel } from "./model.ts";
import { type Backdrop, backdropOf } from "./polarity.ts";
import { measureNoise, type Status } from "./quality.ts";
import type { NamedRect } from "./regions.ts";
import type { RegionSample, RegionTrack } from "./samples.ts";
import type { Lock, Pose } from "./search.ts";
import { type Structure, structureOf } from "./structure.ts";

// Context ring around the element so a flat-coloured element still has edges to match.
export const MARGIN = 6;

export type End = "first" | "last";

export interface TrackRegionInput extends NamedRect {
	ref: "auto" | End;
	/** Automatic content region: the element stays in place and shows, uncovered, at this frame. */
	at?: number;
}

/** A frame the tracker starts from or compares against: a clip end or a rest plateau. */
export interface Anchor {
	k: number;
	plane: Plane;
	frame: Frame;
	rgba: Rgba;
	/** A few consecutive frames at rest from k, for the noise estimate. */
	near: Plane[];
}

/** How one region is tracked from one anchor. */
export interface RegionPlan {
	ref: Anchor;
	other: Anchor;
	/** `rest` when the anchor is a rest plateau inside the clip. */
	label: End | "rest";
	/** Element box at the reference anchor, frame pixels. */
	box: Rect;
	/** Context ring around the box; 0 when the surroundings change between the anchors. */
	ring: number;
	colour: ColourModel | null;
	floor: number;
	/** The box was chosen as what the region holds at both anchors, so the region bounds its travel. */
	bounded: boolean;
}

export interface State {
	region: RegionTrack;
	model: TemplateModel;
	/** The model with light and dark swapped, tried where the backdrop flipped. */
	inverse: TemplateModel;
	/** Box centre in the reference frame, and its offset from the window centre that scales with the element. */
	home: { x: number; y: number };
	offset: { x: number; y: number };
	/** Where a lost element is searched again: the region plus the context ring. */
	area: Rect;
	colour: ColourModel | null;
	/** Blocks of a rigid element, matched where the template fails. */
	structure: Structure | null;
	/** Box centre minus the colour box centre at the reference end. */
	colourOffset: { x: number; y: number };
	/** Quarter-resolution frame where the last wide search failed. */
	missed: Plane | null;
	pose: Pose;
	vel: Pose;
	prevFound: boolean;
	/** Frame of the last found reading, -1 before any. */
	lastK: number;
	/** The pose read at the reference frame, where tracking towards the clip start resumes. */
	start: Pose;
	lock: Lock;
	noise: number;
	/** Backdrop luma around the window at the reference, and the template's swing; see polarity.ts. */
	backdrop: Backdrop;
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

export function initState(
	r: TrackRegionInput,
	plan: RegionPlan,
	frames: number,
	lock: Lock,
): State {
	const { box, colour, ref } = plan;
	const win = expand(box, plan.ring, ref.plane);
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
		clipped: false,
		cut: false,
		repeat: false,
		flipped: false,
		inverted: false,
	}));
	const home = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
	const centre = { x: win.x + win.w / 2, y: win.y + win.h / 2 };
	const cb = colour?.box ?? box;
	const pose = { cx: centre.x, cy: centre.y, s: 1, blur: 0 };
	const model = new TemplateModel(ref.frame, win);
	return {
		region: {
			name: r.name,
			box,
			ref: plan.label,
			refFrame: ref.k,
			samples,
			clipped: [],
			lost: [],
		},
		model,
		inverse: model.inverted(),
		home,
		offset: { x: home.x - centre.x, y: home.y - centre.y },
		area: expand(r, MARGIN, ref.plane),
		colour,
		structure: plan.bounded ? structureOf(ref.frame, box) : null,
		colourOffset: { x: home.x - cb.x - cb.w / 2, y: home.y - cb.y - cb.h / 2 },
		missed: null,
		pose,
		vel: still,
		prevFound: false,
		lastK: -1,
		start: pose,
		lock,
		noise: measureNoise(ref.near, win, plan.floor),
		backdrop: backdropOf(ref.plane, win),
	};
}

/** Turn back to the reference frame, to track towards the start of the clip. */
export function restart(s: State): void {
	const k = s.region.refFrame;
	const found = (s.region.samples[k] as RegionSample).found;
	s.pose = s.start;
	s.vel = still;
	s.prevFound = found;
	s.lastK = found ? k : -1;
	s.missed = null;
}
