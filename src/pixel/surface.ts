import type { ClipRect } from "../capture/options.ts";
import type { TrackedElement } from "../capture/types.ts";
import type { Track } from "../measure/elements.ts";
import { readPng } from "../verify/pixels.ts";
import { type EdgeBand, edgesIn } from "./edge.ts";
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
// An edge that keeps its offset to the element within this (CSS px, or share of the travel) rides on it rigidly.
const RIGID_PX = 3;
const RIGID_SHARE = 0.05;
// Frames that must show the edge apart from the element at rest.
const MIN_FRAMES = 3;
// The element counts as at rest where its box moves less than this between frames, CSS px.
const REST_PX = 0.25;
// A surface edge travels between half and twice as far as the element it carries, in step with it.
const MIN_REACH = 0.5;
const MIN_CORRELATION = 0.9;

type Box = { x: number; y: number; w: number; h: number };

const boxesOf = (track: Track, selector: string, index: number) =>
	track.frames.map(
		(f) =>
			(f.elements[selector]?.find((e) => e.index === index) ?? null) as
				| (Box & Partial<TrackedElement>)
				| null,
	);

const lead = (b: Box, axis: "x" | "y") => (axis === "y" ? b.y : b.x);
const size = (b: Box, axis: "x" | "y") => (axis === "y" ? b.h : b.w);

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

/**
 * Per frame, the position (CSS px along the axis) of the surface edge in the band nearest to the element's box on
 * that frame; null where no edge shows or the element has no box. Page and video frames are read alike.
 */
export async function readEdges(
	dir: string,
	track: Track,
	clip: ClipRect,
	setup: EdgeSetup,
	selector: string,
	index: number,
): Promise<(number | null)[]> {
	const boxes = boxesOf(track, selector, index);
	const { axis, band } = setup;
	const out: (number | null)[] = [];
	for (let k = 0; k < track.frames.length; k++) {
		const box = boxes[k];
		if (!box) {
			out.push(null);
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
		const far = near + size(box, axis);
		const gap = (p: number) => Math.max(0, near - p, p - far);
		const best = edgesIn(png, b)
			.map((e) => o + e.pos / s)
			.sort((p, q) => gap(p) - gap(q))[0];
		out.push(best ?? null);
	}
	return out;
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];

/**
 * The edge belongs to the element's surface: it travels about as far as the element, and with it (the positions
 * correlate), rather than being another edge the nearest-edge choice happened to land on.
 */
function carried(
	seen: { k: number }[],
	leads: readonly (number | null)[],
	edges: readonly (number | null)[],
	travel: number,
): boolean {
	const e = seen.map((s) => edges[s.k] as number);
	const l = seen.map((s) => leads[s.k] as number);
	const reach = Math.max(...e) - Math.min(...e);
	if (reach < MIN_REACH * travel || reach > travel / MIN_REACH) return false;
	const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
	const me = mean(e);
	const ml = mean(l);
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	e.forEach((v, i) => {
		const dx = v - me;
		const dy = (l[i] as number) - ml;
		sxy += dx * dy;
		sxx += dx * dx;
		syy += dy * dy;
	});
	return sxx > 0 && syy > 0 && sxy / Math.sqrt(sxx * syy) >= MIN_CORRELATION;
}

/**
 * The surface edge as a tracked element, one box per frame: from the edge across the element at rest. Where the
 * edge does not show while the element rests (a white sheet on a white page), it is held as edge-rest.ts says;
 * while the element moves there, the frame has no box. Null when the edge rides rigidly on the element or is not
 * its surface's, unless `always`: verify measures a clone's edge whatever it does.
 */
export function edgeElements(
	track: Track,
	selector: string,
	index: number,
	setup: EdgeSetup,
	edges: readonly (number | null)[],
	always = false,
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
	const apart = Math.max(...offsets) - Math.min(...offsets);
	const rigid = apart <= Math.max(RIGID_PX, RIGID_SHARE * travel);
	if (!always && (rigid || !carried(seen, leads, edges, travel))) return null;
	const atRest = seen.filter((s) => rest[s.k]).map((s) => s.offset);
	const offset = median(atRest.length > 0 ? atRest : offsets) as number;
	const extent = Math.max(...boxes.flatMap((b) => (b ? [size(b, axis)] : [])));
	// From the edge across the element: a top edge reaches the element's far side, a bottom edge its near side.
	const span = Math.max(1, offset <= 0 ? extent - offset : offset);
	const fills = restFills(leads, rest, edges);
	return boxes.map((b, k) => {
		const e = edges[k];
		const shown = e !== null && e !== undefined;
		const pos = shown ? e : fills[k];
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
			observed: { position: true, scale: false, blur: false, opacity: false },
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
