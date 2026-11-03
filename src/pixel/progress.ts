import type { Series } from "../measure/series.ts";
import { activityCurve, changeWindows, meanAbs } from "./activity.ts";

export interface ProgressWindow {
	/** Rest frames bracketing the change: the last one before it and the first one after it. */
	fromFrame: number;
	toFrame: number;
	fromMs: number;
	toMs: number;
	/** Mean absolute RGB difference between the two rest frames, 0..255. */
	distance: number;
	/** Largest share of the change, on any frame inside it, that is not a mix of the two rest frames: near 0 for a fade, a dim or a cross-fade. */
	blend: number;
	/** [tMs, progress]: 1 - dist(frame, end) / dist(start, end), over the rest frames on either side too. */
	series: Series;
}

// The share of a frame's pixels that a mix of the two rest frames leaves unexplained.
function mixResidual(
	f: Uint8Array,
	start: Uint8Array,
	end: Uint8Array,
	p: number,
	distance: number,
): number {
	let sum = 0;
	for (let i = 0; i < f.length; i++) {
		const s = start[i] as number;
		sum += Math.abs((f[i] as number) - s - p * ((end[i] as number) - s));
	}
	return f.length ? sum / f.length / distance : 0;
}

/** Appearance progress of one region for every change its frames show. */
export function progressWindows(
	frames: readonly Uint8Array[],
	t: readonly number[],
	frameMs: number,
): ProgressWindow[] {
	const windows = changeWindows(activityCurve(frames), frameMs);
	return windows.flatMap((w, i) => {
		const start = frames[w.from] as Uint8Array;
		const end = frames[w.to] as Uint8Array;
		const distance = meanAbs(start, end);
		if (distance === 0) return [];
		const first = windows[i - 1]?.to ?? 0;
		const last = windows[i + 1]?.from ?? frames.length - 1;
		const series: Series = [];
		let blend = 0;
		for (let k = first; k <= last; k++) {
			const f = frames[k] as Uint8Array;
			const p = 1 - meanAbs(f, end) / distance;
			series.push([t[k] as number, p]);
			if (k > w.from && k < w.to)
				blend = Math.max(blend, mixResidual(f, start, end, p, distance));
		}
		return [
			{
				fromFrame: w.from,
				toFrame: w.to,
				fromMs: t[w.from] as number,
				toMs: t[w.to] as number,
				distance,
				blend,
				series,
			},
		];
	});
}
