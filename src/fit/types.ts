/** [tMs, progress] with progress normalised so the motion goes from 0 to 1. */
export type Sample = readonly [number, number];

/** Where the motion sits in time, from its measured window. */
export interface Hint {
	startMs: number;
	endMs: number;
	frameMs: number;
}
