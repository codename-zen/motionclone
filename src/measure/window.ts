import type { Series } from "./series.ts";

export interface MotionWindow {
	startMs: number;
	endMs: number;
	durationMs: number;
	from: number;
	to: number;
	/** to - from; near zero for there-and-back motion. */
	change: number;
	/** Value furthest from `from`, with the time it is reached. */
	peak: number;
	peakMs: number;
	/** Beyond `to`, against the direction of travel, as a fraction of |change|. */
	overshoot: number;
	/** Returns near the start value, so the sample window covers the whole round trip. */
	thereAndBack: boolean;
	/** |change| (|peak - from| when there and back) divided by the element size, when given. */
	relative: number | null;
}

interface Options {
	/** Fraction of the total change treated as noise. */
	floor?: number;
	/** Element size along the motion axis, for the relative distance. */
	size?: number;
}

export function motionWindow(
	series: Series,
	{ floor = 0.01, size }: Options = {},
): MotionWindow | null {
	const first = series[0];
	const last = series.at(-1);
	if (!first || !last || series.length < 2) return null;
	const from = first[1];
	const to = last[1];
	let peakIdx = 0;
	for (let i = 1; i < series.length; i++)
		if (
			Math.abs((series[i]?.[1] ?? from) - from) >
			Math.abs((series[peakIdx]?.[1] ?? from) - from)
		)
			peakIdx = i;
	const [peakMs, peak] = series[peakIdx] as readonly [number, number];
	const amplitude = peak - from;
	if (Math.abs(amplitude) < 1e-9) return null;
	const thereAndBack = Math.abs(to - from) < 0.1 * Math.abs(amplitude);
	const tol = floor * Math.abs(thereAndBack ? amplitude : to - from);

	const startIdx = series.findIndex(([, v]) => Math.abs(v - from) > tol);
	let endIdx = series.length - 1;
	while (endIdx > 0 && Math.abs((series[endIdx - 1]?.[1] ?? to) - to) <= tol)
		endIdx--;
	if (startIdx < 0) return null;
	endIdx = Math.max(endIdx, startIdx);
	const startMs = (series[startIdx] as readonly [number, number])[0];
	const endMs = (series[endIdx] as readonly [number, number])[0];

	const change = to - from;
	let overshoot = 0;
	if (!thereAndBack) {
		const dir = Math.sign(change);
		for (const [, v] of series)
			overshoot = Math.max(overshoot, (dir * (v - to)) / Math.abs(change));
	}
	return {
		startMs,
		endMs,
		durationMs: endMs - startMs,
		from,
		to,
		change,
		peak,
		peakMs,
		overshoot,
		thereAndBack,
		relative: size ? Math.abs(thereAndBack ? amplitude : change) / size : null,
	};
}
