import type { ClipRect } from "../capture/options.ts";
import type { Track } from "../measure/elements.ts";
import type { Series } from "../measure/series.ts";
import { motionWindow } from "../measure/window.ts";
import {
	elementRegion,
	FRAME,
	measureProgress,
	type ProgressWindow,
	type Rect,
} from "../pixel/measure.ts";
import { elementKey, fitMotion } from "../spec/motion.ts";
import { isSwitchWindow } from "../spec/progress-row.ts";
import { PROGRESS, type SpecRow } from "../spec/schema.ts";
import { type CloneMotion, measuredTiming } from "./clone.ts";

export const PIXEL_OPACITY_NOTE =
	"the clone's CSS opacity does not change here, so its appearance was measured from pixels in the element's box, as the video's opacity was";

/** Rows the clone answers from its pixels: progress rows, and video opacity rows the clone does not animate with CSS opacity. */
export const needsPixels = (
	row: SpecRow,
	c: CloneMotion | undefined,
	video: boolean,
) =>
	row.property === PROGRESS ||
	(video && row.property === "opacity" && c?.status === "static");

const endOf = (r: SpecRow) => r.startMs + r.durationMs;

// The clone's change that overlaps the row's motion most; the nearest one when none overlaps.
function pick(
	windows: readonly ProgressWindow[],
	row: SpecRow,
): ProgressWindow | null {
	const overlap = (w: ProgressWindow) =>
		Math.min(w.toMs, endOf(row)) - Math.max(w.fromMs, row.startMs);
	const distance = (w: ProgressWindow) => Math.abs(w.fromMs - row.startMs);
	return (
		[...windows].sort(
			(a, b) =>
				Math.max(0, overlap(b)) - Math.max(0, overlap(a)) ||
				distance(a) - distance(b),
		)[0] ?? null
	);
}

function motionOf(row: SpecRow, w: ProgressWindow): CloneMotion | null {
	const series: Series = w.series.map(([t, p]) => [
		t,
		row.from + p * (row.to - row.from),
	]);
	const window = motionWindow(series);
	if (!window) return null;
	const fit = fitMotion({ series, window });
	// A switch has no shape to fit: the rest frames on both sides are its timing.
	const timing = isSwitchWindow(w)
		? { startMs: w.fromMs, durationMs: w.toMs - w.fromMs, easing: row.easing }
		: measuredTiming(fit, row);
	return {
		status: "moving",
		motion: { series, window },
		fit,
		...timing,
		notes: row.property === PROGRESS ? [] : [PIXEL_OPACITY_NOTE],
	};
}

/** A reference region in the clone's coordinates: the same place on its captured area. */
export function placeRegion(r: Rect, from: ClipRect, to: ClipRect): Rect {
	const s = to.width / from.width;
	const place = (b: Rect): Rect => ({
		x: to.x + (b.x - from.x) * s,
		y: to.y + (b.y - from.y) * s,
		w: b.w * s,
		h: b.h * s,
	});
	return { ...place(r), exclude: r.exclude?.map(place) };
}

/**
 * Measure rows on the clone's frames with the pixel method the reference used (ADR 0004, ADR 0005), in the box of
 * the element each row names, after any --map renaming. Rows whose element shows no change keep their measurement.
 * Frame rows use `frame`: the reference's frame region placed on the clone, so both leave out the same boxes.
 */
export async function measurePixelRows(
	dir: string,
	track: Track,
	clip: ClipRect,
	rows: readonly SpecRow[],
	frame: Rect | null = null,
): Promise<Map<string, CloneMotion>> {
	const regions = new Map<string, Rect>();
	for (const r of rows) {
		const key = elementKey(r.selector, r.index);
		const region =
			r.selector === FRAME ? frame : elementRegion(track, r.selector, r.index);
		if (region && !regions.has(key)) regions.set(key, region);
	}
	const keys = [...regions.keys()];
	const measured = await measureProgress(dir, track, clip, [
		...regions.values(),
	]);
	const windows = new Map(keys.map((k, i) => [k, measured[i]?.windows ?? []]));
	const out = new Map<string, CloneMotion>();
	for (const r of rows) {
		const w = pick(windows.get(elementKey(r.selector, r.index)) ?? [], r);
		const c = w ? motionOf(r, w) : null;
		if (c) out.set(r.id, c);
	}
	return out;
}
