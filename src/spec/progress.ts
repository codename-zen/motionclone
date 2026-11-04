import type { ClipRect } from "../capture/options.ts";
import type { Track } from "../measure/elements.ts";
import type { Series } from "../measure/series.ts";
import type { Span } from "../pixel/measure.ts";
import {
	elementRegion,
	FRAME,
	frameRegion,
	measureProgress,
	type ProgressWindow,
	type Rect,
} from "../pixel/measure.ts";
import { contains, overlaps } from "../pixel/region.ts";
import { isEdge } from "../pixel/surface.ts";
import { flippedSpans, holdsStill } from "./flipped.ts";
import { elementKey, trackedElements } from "./motion.ts";
import { type ProgressSource, progressRow } from "./progress-row.ts";
import type { SpecRow } from "./schema.ts";

// A change whose frames are mixes of its two rest frames within this share: a fade, a dim or a cross-fade.
// Fades measure 0.003 to 0.01 on page and h264 frames; moving or scaling content 0.1 and more (ADR 0005).
export const BLEND_MAX = 0.05;
// Text whose colour fades is not an exact mix: glyph edges are drawn with a gamma that follows the text colour,
// which leaves up to 0.06. Between two backdrop flips, with the element holding still, nothing else changes there.
const SPAN_BLEND_MAX = 0.1;
// Smaller changes, in mean RGB levels over the region, are antialiasing or encoder noise.
const MIN_DISTANCE = 2;
// On a page, rows explain a change when they run over this share of it.
const EXPLAINED = 0.9;

type Candidate = Omit<ProgressSource, "ordinal">;
type Element = { selector: string; index: number; region: Rect; span?: Span };

// A change read over the whole capture that lies inside one of its element's spans is read in that span instead.
const withoutSpanned = (changes: Candidate[], elements: readonly Element[]) =>
	changes.filter(
		(c) =>
			c.span !== undefined ||
			!elements.some(
				(e) =>
					e.span &&
					e.selector === c.selector &&
					e.index === c.index &&
					c.window.fromMs > e.span.firstMs &&
					c.window.toMs < e.span.lastMs,
			),
	);

// Each element's changes by time, elements in their first order, so ordinals count in time.
function inTimeOrder(changes: Candidate[]): Candidate[] {
	const keys = [
		...new Set(changes.map((c) => elementKey(c.selector, c.index))),
	];
	return keys.flatMap((k) =>
		changes
			.filter((c) => elementKey(c.selector, c.index) === k)
			.sort((a, b) => a.window.fromMs - b.window.fromMs),
	);
}

function changesOf(
	elements: Element[],
	measured: { windows: ProgressWindow[] }[],
	track: Track,
): Candidate[] {
	const limit = (e: Element, w: ProgressWindow) =>
		e.span && holdsStill(track, e.selector, e.index, w.fromMs, w.toMs)
			? SPAN_BLEND_MAX
			: BLEND_MAX;
	return elements.flatMap((e, i) =>
		(measured[i]?.windows ?? [])
			.filter((w) => w.blend <= limit(e, w) && w.distance >= MIN_DISTANCE)
			.map((window) => ({ ...e, window })),
	);
}

// Share of the change's frames that rows of elements over the same region are running on.
function explainedShare(
	c: Candidate,
	rows: readonly SpecRow[],
	regions: Map<string, Rect>,
	frameMs: number,
): number {
	const spans = rows
		.filter((r) => {
			const region = regions.get(elementKey(r.selector, r.index));
			return region !== undefined && covers(c.region, region);
		})
		.map((r) => [r.startMs - frameMs, r.startMs + r.durationMs + frameMs]);
	const frames = c.window.series.filter(
		([t]) => t > c.window.fromMs && t <= c.window.toMs,
	);
	const covered = frames.filter(([t]) =>
		spans.some(([a, b]) => t >= (a as number) && t <= (b as number)),
	);
	return frames.length ? covered.length / frames.length : 1;
}

// Whether a region shows inside another, outside the parts the outer one leaves out.
const shownIn = (outer: Rect, inner: Rect) =>
	!outer.exclude?.some((e) => contains(e, inner));
const covers = (outer: Rect, inner: Rect) =>
	overlaps(outer, inner) && shownIn(outer, inner);

// A change seen in an element and in a smaller element inside it, at the same time, belongs to the smaller one.
const nested = (c: Candidate, all: readonly Candidate[]) =>
	all.some(
		(o) =>
			o !== c &&
			o.region.w * o.region.h < c.region.w * c.region.h &&
			contains(c.region, o.region) &&
			shownIn(c.region, o.region) &&
			o.window.fromMs < c.window.toMs &&
			c.window.fromMs < o.window.toMs,
	);

export interface DraftedProgress {
	row: SpecRow;
	series: Series;
}

/**
 * Progress rows for appearance changes the tracked rows do not measure (ADR 0005).
 * From a video every fade-like change of a region gets one; from a page only those no row over the element explains.
 * The frame, without the boxes of moving elements, is a region too: a background that flips behind a sliding sheet.
 */
export async function draftProgressRows(input: {
	dir: string;
	track: Track;
	clip: ClipRect;
	rows: readonly SpecRow[];
	video: boolean;
	noise: number;
}): Promise<DraftedProgress[]> {
	const { track, rows } = input;
	// A surface edge's box is drawn from its position; its appearance belongs to the element it carries.
	const elements: Element[] = trackedElements(track).flatMap((e) => {
		if (isEdge(e.selector)) return [];
		const region = elementRegion(track, e.selector, e.index);
		if (!region) return [];
		// On a video, fades on a flipped backdrop are read between the flips, where the backdrop holds still.
		const spans = flippedSpans(track, e.selector, e.index);
		return [{ ...e, region }, ...spans.map((span) => ({ ...e, region, span }))];
	});
	const frame = frameRegion(track, input.clip);
	if (frame) elements.push({ selector: FRAME, index: 0, region: frame });
	if (elements.length === 0) return [];
	const measured = await measureProgress(
		input.dir,
		track,
		input.clip,
		elements.map((e) => e.region),
		elements.map((e) => e.span ?? null),
	);
	const regions = new Map(
		elements.map((e) => [elementKey(e.selector, e.index), e.region]),
	);
	const changes = inTimeOrder(
		withoutSpanned(changesOf(elements, measured, track), elements),
	).filter(
		(c) =>
			input.video ||
			explainedShare(c, rows, regions, track.frameMs) < EXPLAINED,
	);
	const ordinals = new Map<string, number>();
	return changes
		.filter((c) => !nested(c, changes))
		.flatMap((c) => {
			const key = elementKey(c.selector, c.index);
			const ordinal = (ordinals.get(key) ?? 0) + 1;
			const row = progressRow({ ...c, ordinal }, input.noise, track.frameMs);
			if (!row) return [];
			ordinals.set(key, ordinal);
			return [{ row, series: c.window.series }];
		});
}
