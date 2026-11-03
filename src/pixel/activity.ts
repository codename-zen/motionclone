/** Mean absolute RGB difference of two sampled regions, 0..255. */
export function meanAbs(a: Uint8Array, b: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++)
		sum += Math.abs((a[i] as number) - (b[i] as number));
	return a.length ? sum / a.length : 0;
}

/** Change from frame k-1 to frame k per frame k, 0 at k = 0. */
export const activityCurve = (frames: readonly Uint8Array[]): number[] =>
	frames.map((f, k) => (k === 0 ? 0 : meanAbs(f, frames[k - 1] as Uint8Array)));

/** A change between two rest frames: the last frame before it and the first frame after it. */
export interface ChangeWindow {
	from: number;
	to: number;
}

// A frame changing by less than this (mean RGB levels) is at rest, whatever the encoder noise.
const REST_LEVEL = 0.5;
// Compression noise between still frames, as a multiple of the quietest quarter of the capture.
const NOISE_MULTIPLE = 3;
// Rest runs this short inside a change are a slow moment of it, not its end.
const MERGE_MS = 50;

function restLimit(activity: readonly number[]): number {
	const sorted = activity.slice(1).sort((a, b) => a - b);
	const quiet = sorted[Math.floor(sorted.length / 4)] ?? 0;
	return Math.max(REST_LEVEL, NOISE_MULTIPLE * quiet);
}

/** Runs of change in an activity curve, each between the rest frames that bracket it. */
export function changeWindows(
	activity: readonly number[],
	frameMs: number,
): ChangeWindow[] {
	const limit = restLimit(activity);
	const merge = Math.max(2, Math.round(MERGE_MS / frameMs));
	const out: ChangeWindow[] = [];
	for (let k = 1; k < activity.length; k++) {
		if ((activity[k] as number) <= limit) continue;
		const last = out.at(-1);
		if (last && k - last.to <= merge) last.to = k;
		else out.push({ from: k - 1, to: k });
	}
	return out;
}
