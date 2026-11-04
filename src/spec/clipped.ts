import type { Track } from "../measure/elements.ts";
import type { CaptureFile } from "./capture-file.ts";
import type { SpecRow } from "./schema.ts";

// A clip at the region edge cuts geometry short; opacity, blur and rotation are not distances along it.
const GEOMETRY = new Set([
	"x",
	"y",
	"width",
	"height",
	"translateX",
	"translateY",
	"scale",
	"scaleX",
	"scaleY",
]);

export const LOWER_BOUND_NOTE =
	"distance is a lower bound: the element was clipped at its region edge during the motion, so it moves at least this far";

/** Times a video region cut an element's travel at its edge: capture.json `video.clippedTravel` (ADR 0002). */
export interface ClippedRange {
	selector: string;
	index: number;
	fromMs: number;
	toMs: number;
}

export const clippedRanges = (cap: CaptureFile): ClippedRange[] =>
	(cap as { video?: { clippedTravel?: ClippedRange[] } }).video
		?.clippedTravel ?? [];

/** Whether the row's element was clipped at its region edge at any time of its motion. */
function clippedDuring(
	track: Track,
	ranges: readonly ClippedRange[],
	row: SpecRow,
): boolean {
	const end = row.startMs + row.durationMs;
	const inRange = ranges.some(
		(c) =>
			c.selector === row.selector &&
			c.index === row.index &&
			c.fromMs <= end &&
			c.toMs >= row.startMs,
	);
	return (
		inRange ||
		track.frames.some((f) => {
			if (f.t < row.startMs || f.t > end) return false;
			const e = f.elements[row.selector]?.find((x) => x.index === row.index);
			return e?.clipped === true;
		})
	);
}

/** The row with its distance marked as a lower bound when its element was clipped while it moved. */
export function clippedDistance(
	row: SpecRow,
	track: Track,
	ranges: readonly ClippedRange[],
): SpecRow {
	if (!GEOMETRY.has(row.property) || !clippedDuring(track, ranges, row))
		return row;
	return {
		...row,
		distanceObserved: "lower-bound",
		notes: [...row.notes, LOWER_BOUND_NOTE],
	};
}
