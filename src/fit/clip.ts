import type { Hint } from "./types.ts";

/**
 * Delay and duration held inside the hint's clip, as `timingProblem` allows: the start from a frame before the
 * first frame to the last frame, the end at most a frame after the last frame. Without a clip only the duration is
 * kept positive. Optimisers see this projection, so a plateau cannot stretch a fit off the clip.
 */
export function clampTiming(
	hint: Hint,
	delayMs: number,
	durationMs: number,
): { delayMs: number; durationMs: number } {
	const c = hint.clip;
	if (!c) return { delayMs, durationMs: Math.max(1, durationMs) };
	const delay = Math.min(c.lastMs, Math.max(c.firstMs - hint.frameMs, delayMs));
	const longest = Math.max(
		1,
		Math.min(c.lastMs - delay, c.lastMs - c.firstMs) + hint.frameMs,
	);
	return {
		delayMs: delay,
		durationMs: Math.min(longest, Math.max(1, durationMs)),
	};
}

/** Whether a timing already lies inside the hint's clip. */
export const insideClip = (hint: Hint, delayMs: number, durationMs: number) => {
	const t = clampTiming(hint, delayMs, durationMs);
	return t.delayMs === delayMs && t.durationMs === durationMs;
};

/**
 * Whether a clamped timing rests on a limit of the clip: a fit the clip had to stop, such as a plateau read as a
 * curve of near-infinite duration, which drafting treats as running off the clip.
 */
export function pinned(
	hint: Hint,
	delayMs: number,
	durationMs: number,
): boolean {
	const c = hint.clip;
	if (!c) return false;
	const eps = 1e-6 * Math.max(1, c.lastMs - c.firstMs);
	const near = (a: number, b: number) => Math.abs(a - b) <= eps;
	const t = clampTiming(hint, delayMs, Number.POSITIVE_INFINITY);
	return (
		near(delayMs, c.firstMs - hint.frameMs) ||
		near(delayMs, c.lastMs) ||
		near(durationMs, t.durationMs)
	);
}
