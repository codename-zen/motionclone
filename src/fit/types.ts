/** [tMs, progress] with progress normalised so the motion goes from 0 to 1. */
export type Sample = readonly [number, number];

/** Where the motion sits in time, from its measured window. */
export interface Hint {
	startMs: number;
	endMs: number;
	frameMs: number;
}

/** A reading that holds the true value somewhere in [lo, hi]; lo === hi for a plain measurement. */
export interface Observation {
	t: number;
	lo: number;
	hi: number;
	/** Match quality 0..1 the tracker reports for this frame, when it does. */
	q?: number;
	/** The tracker filled this value in instead of seeing it; it is fitted, but not counted as a sample. */
	filled?: boolean;
}
