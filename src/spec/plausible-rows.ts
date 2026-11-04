import { type TimeBounds, timingProblem } from "../fit/plausible.ts";
import { MIN_RANGE, type Track } from "../measure/elements.ts";
import type { Property } from "../measure/series.ts";
import { type DroppedRow, PROGRESS, type SpecRow } from "./schema.ts";

// A fully seen motion whose best curve misses the readings by this rms share of the change is no motion at all.
const POOR_FIT = 0.2;

/** The clip of a track: its first and last frame time. */
export const trackBounds = (track: Track, frameMs: number): TimeBounds => ({
	firstMs: track.frames[0]?.t ?? 0,
	lastMs: track.frames.at(-1)?.t ?? 0,
	frameMs,
});

/** Why a drafted row describes no motion of the clip, or null when it does. */
export function dropReason(row: SpecRow, bounds: TimeBounds): string | null {
	if (row.property !== PROGRESS) {
		const floor = MIN_RANGE[row.property as Property];
		if (Math.abs(row.to - row.from) < floor)
			return `it ends where it starts (${row.from}, change under ${floor}): a move away and back, or a reading glitch, is not a motion row`;
	}
	// Declared timing is the page's own; only fitted timing can run off the clip.
	if (row.source === "declared") return null;
	if (row.fromObserved && row.property !== PROGRESS && row.rmse > POOR_FIT)
		return `no plausible fit: the best curve misses the readings by ${row.rmse} of the change (rms), as a loop cut mid-cycle or a tracker glitch does`;
	const problem = timingProblem(row.startMs, row.durationMs, bounds);
	return problem
		? `no plausible fit: ${problem} (fitted start ${row.startMs} ms, duration ${row.durationMs} ms)`
		: null;
}

/** Rows that describe a motion of the clip; the others go to `dropped` with their reason. */
export function keepPlausible(
	rows: readonly SpecRow[],
	bounds: TimeBounds,
	dropped: DroppedRow[],
): SpecRow[] {
	return rows.filter((row) => {
		const reason = dropReason(row, bounds);
		if (reason === null) return true;
		dropped.push({
			id: row.id,
			selector: row.selector,
			index: row.index,
			property: row.property,
			reason,
		});
		return false;
	});
}
