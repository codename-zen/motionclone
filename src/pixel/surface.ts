import type { ClipRect } from "../capture/options.ts";
import type { TrackedElement } from "../capture/types.ts";
import type { Track } from "../measure/elements.ts";
import { lost } from "../measure/series.ts";
import { readPng } from "../verify/pixels.ts";
import { type EdgeBand, edgesIn } from "./edge.ts";
import {
	type Box,
	carried,
	lead,
	ridesRigidly,
	size,
	sweeps,
} from "./edge-belongs.ts";
import {
	type EdgeCandidate,
	edgeKinds,
	followEdge,
	type Span,
	STALE,
	START_STEP,
} from "./edge-follow.ts";
import { restFills } from "./edge-rest.ts";
import { elementRegion, type Rect } from "./region.ts";

/** Suffix of the pseudo element that is a tracked element's surface edge: `sheet::edge`. */
export const EDGE = "::edge";
export const isEdge = (selector: string) => selector.endsWith(EDGE);
export const edgeOwner = (selector: string) => selector.slice(0, -EDGE.length);

/** Where an element's surface edge is looked for: the band across its whole travel, CSS px. */
export interface EdgeSetup {
	axis: "x" | "y";
	/** Columns (rows for a vertical edge) of the element's boxes; along the axis, its travel and a box size around it. */
	band: Rect;
}

// An element must travel this far, CSS px, for a surface edge around it to be looked for.
const MIN_TRAVEL = 8;
// Frames that must show the edge apart from the element at rest.
const MIN_FRAMES = 3;
// The element counts as at rest where its box moves less than this between frames, CSS px.
const REST_PX = 0.25;

const boxesOf = (track: Track, selector: string, index: number) =>
	track.frames.map(
		(f) =>
			(f.elements[selector]?.find((e) => e.index === index) ?? null) as
				| (Box & Partial<TrackedElement>)
				| null,
	);

/** The band to search for an element's surface edge, or null when the element does not travel. */
export function edgeSetup(
	track: Track,
	selector: string,
	index: number,
): EdgeSetup | null {
	const boxes = boxesOf(track, selector, index).filter((b) => b !== null);
	const union = elementRegion(track, selector, index);
	if (!union || boxes.length === 0) return null;
	const spread = (f: (b: Box) => number) =>
		Math.max(...boxes.map(f)) - Math.min(...boxes.map(f));
	const axis = spread((b) => b.y) >= spread((b) => b.x) ? "y" : "x";
	if (spread((b) => lead(b, axis)) < MIN_TRAVEL) return null;
	const pad = Math.max(...boxes.map((b) => size(b, axis)));
	const band =
		axis === "y"
			? { x: union.x, y: union.y - pad, w: union.w, h: union.h + 2 * pad }
			: { x: union.x - pad, y: union.y, w: union.w + 2 * pad, h: union.h };
	return { axis, band };
}

/** A video frame that shows nothing of the element: the tracker lost it, or the recording repeated the frame. */
const unseen = (e: TrackedElement) =>
	e.repeated === true || (lost(e) && e.clipped !== true);

// Steps this strong continue an edge that a stronger step started (edge-follow.ts).
const KEEP_STEP = START_STEP / 2;

/**
 * Per frame, the position (CSS px along the axis) of an edge in the band that starts nearest to the element's box
 * and is followed from frame to frame (edge-follow.ts); null where it does not show or the element has no reading,
 * as on frames a video tracker lost or a recording repeated. One such track per kind of edge the band holds, the
 * kind nearest the element at rest first. Page and video frames are read alike.
 */
export async function readEdges(
	dir: string,
	track: Track,
	clip: ClipRect,
	setup: EdgeSetup,
	selector: string,
	index: number,
): Promise<(number | null)[][]> {
	const boxes = boxesOf(track, selector, index);
	const { axis, band } = setup;
	const cands: (EdgeCandidate[] | null)[] = [];
	const spans: Span[] = [];
	for (let k = 0; k < track.frames.length; k++) {
		const box = boxes[k];
		if (!box || unseen(box as TrackedElement)) {
			cands.push(null);
			spans.push(null);
			continue;
		}
		const png = await readPng(dir, k);
		const s = png.width / clip.width;
		const o = axis === "y" ? clip.y : clip.x;
		const px = (v: number, c: number) => Math.round((v - c) * s);
		const b: EdgeBand =
			axis === "y"
				? {
						axis,
						a0: px(band.x, clip.x),
						a1: px(band.x + band.w, clip.x),
						b0: px(band.y, clip.y),
						b1: px(band.y + band.h, clip.y),
					}
				: {
						axis,
						a0: px(band.y, clip.y),
						a1: px(band.y + band.h, clip.y),
						b0: px(band.x, clip.x),
						b1: px(band.x + band.w, clip.x),
					};
		const near = lead(box, axis);
		spans.push({ near, far: near + size(box, axis) });
		cands.push(
			edgesIn(png, b, KEEP_STEP).map((e) => ({
				pos: o + e.pos / s,
				step: e.step,
				line: e.line,
			})),
		);
	}
	return edgeKinds(cands, spans).map((kind) => followEdge(cands, spans, kind));
}

/**
 * The surface edge of the first kind whose edge belongs to the element's surface (edgeElements), so lines that ride
 * on the content, such as rules of a list that scrolls with it, give way to the panel edge behind them. With
 * `always`, the nearest kind's edge when none belongs.
 */
export function surfaceEdge(
	track: Track,
	selector: string,
	index: number,
	setup: EdgeSetup,
	kinds: readonly (readonly (number | null)[])[],
	always = false,
	clip: ClipRect | null = null,
): (TrackedElement | null)[] | null {
	for (const edges of kinds) {
		const found = edgeElements(
			track,
			selector,
			index,
			setup,
			edges,
			false,
			clip,
		);
		if (found) return found;
	}
	const nearest = kinds[0];
	return always && nearest
		? edgeElements(track, selector, index, setup, nearest, true, clip)
		: null;
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];

/**
 * The surface edge as a tracked element, one box per frame: from the edge across the element at rest. Where the
 * edge does not show while the element rests (a white sheet on a white page), it is held as edge-rest.ts says;
 * while the element moves there, the frame has no box. Null when the edge rides rigidly on the element or is not
 * its surface's, unless `always`: verify measures a clone's edge whatever it does. With `clip`, rests where the
 * element lies off the captured area hold nothing.
 */
export function edgeElements(
	track: Track,
	selector: string,
	index: number,
	setup: EdgeSetup,
	edges: readonly (number | null)[],
	always = false,
	clip: ClipRect | null = null,
): (TrackedElement | null)[] | null {
	const { axis, band } = setup;
	const boxes = boxesOf(track, selector, index);
	const rest = boxes.map((b, k) => {
		const near = [boxes[k - 1], boxes[k + 1]].filter((x) => x);
		return (
			b !== null &&
			near.length > 0 &&
			near.some((x) => Math.abs(lead(x as Box, axis) - lead(b, axis)) < REST_PX)
		);
	});
	const seen = boxes.flatMap((b, k) => {
		const e = edges[k];
		return b && e !== null && e !== undefined
			? [{ k, offset: e - lead(b, axis) }]
			: [];
	});
	if (seen.length < MIN_FRAMES) return null;
	const leads = boxes.map((b) => (b ? lead(b, axis) : null));
	const placed = leads.filter((v) => v !== null);
	const travel = Math.max(...placed) - Math.min(...placed);
	const offsets = seen.map((s) => s.offset);
	const rigid = ridesRigidly(seen, travel, STALE);
	const belongs =
		carried(seen, leads, edges, travel) ||
		sweeps(seen, boxes, edges, axis, travel);
	if (!always && (rigid || !belongs)) return null;
	const atRest = seen.filter((s) => rest[s.k]).map((s) => s.offset);
	const offset = median(atRest.length > 0 ? atRest : offsets) as number;
	const extent = Math.max(...boxes.flatMap((b) => (b ? [size(b, axis)] : [])));
	// From the edge across the element: a top edge reaches the element's far side, a bottom edge its near side.
	const span = Math.max(1, offset <= 0 ? extent - offset : offset);
	// A rest off the screen (a closed panel) shows nothing to hold; one in view may hide its edge on the page.
	const inView = (b: Box | null) =>
		!clip ||
		(b !== null &&
			b.x < clip.x + clip.width &&
			b.x + b.w > clip.x &&
			b.y < clip.y + clip.height &&
			b.y + b.h > clip.y);
	const fills = restFills(
		leads,
		rest.map((r, k) => r && inView(boxes[k] ?? null)),
		edges,
	);
	// Before the edge first shows (a panel that enters from off the screen), it holds its first position unseen:
	// its true start lies there or further, so the row is partly observed (ADR 0003).
	const first = edges.findIndex((e) => e !== null && e !== undefined);
	return boxes.map((b, k) => {
		const e = edges[k];
		const shown = e !== null && e !== undefined;
		const before = k < first && fills[k] == null;
		const pos = shown ? e : before ? edges[first] : fills[k];
		if (!b || pos === null || pos === undefined) return null;
		const start = offset <= 0 ? pos : pos - span;
		const r1 = (v: number) => Math.round(v * 10) / 10;
		return {
			index,
			x: r1(axis === "y" ? band.x : start),
			y: r1(axis === "y" ? start : band.y),
			w: r1(axis === "y" ? band.w : span),
			h: r1(axis === "y" ? span : band.h),
			opacity: 1,
			transform: "none",
			filter: "none",
			clipPath: "none",
			color: "",
			backgroundColor: "",
			boxShadow: "none",
			// A held position stands for the rest it was taken from; quality 0 keeps it from counting as a sample.
			quality: shown ? 1 : 0,
			observed: {
				position: !before,
				scale: false,
				blur: false,
				opacity: false,
			},
		};
	});
}

/** The track with the surface edge of each listed element added as `<selector>::edge`. */
export function withEdgeTrack(
	track: Track,
	added: {
		selector: string;
		index: number;
		elements: (TrackedElement | null)[];
	}[],
): Track {
	if (added.length === 0) return track;
	const names = [...new Set(added.map((a) => `${a.selector}${EDGE}`))];
	return {
		...track,
		selectors: [...track.selectors.filter((s) => !names.includes(s)), ...names],
		frames: track.frames.map((f, k) => {
			const elements = { ...f.elements };
			for (const a of added) {
				const e = a.elements[k];
				if (!e) continue;
				const key = `${a.selector}${EDGE}`;
				elements[key] = [...(elements[key] ?? []), e].sort(
					(p, q) => p.index - q.index,
				);
			}
			return { ...f, elements };
		}),
	};
}
