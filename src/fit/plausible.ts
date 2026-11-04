import { bezierY } from "./bezier.ts";
import type { BezierParams } from "./presets.ts";
import type { Sample } from "./types.ts";

/** A transition shorter than this many frames has no shape to fit. */
export const MIN_FRAMES = 2;
// A curve that gains more than this much progress within 2 % of its time is a step, not an easing.
const STEP_JUMP = 0.4;
const STEP_SPAN = 0.02;

/** Overshoot or undershoot below this share of the change is noise. */
export const OVERSHOOT_MIN = 0.02;

/** How far progress samples go below 0 and above 1. */
export function excursion(samples: readonly Sample[]): {
	under: number;
	over: number;
} {
	let under = 0;
	let over = 0;
	for (const [, p] of samples) {
		under = Math.max(under, -p);
		over = Math.max(over, p - 1);
	}
	return { under, over };
}

export const goesPast = (seen: { under: number; over: number }) =>
	seen.under > OVERSHOOT_MIN || seen.over > OVERSHOOT_MIN;

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));

/** Smallest and largest progress the curve reaches. */
export function curveRange(curve: (u: number) => number): [number, number] {
	let lo = 0;
	let hi = 1;
	for (let i = 1; i < 200; i++) {
		const y = curve(i / 200);
		lo = Math.min(lo, y);
		hi = Math.max(hi, y);
	}
	return [lo, hi];
}

/** A near-vertical jump inside the curve: a near-zero-length segment that no easing describes. */
export function isStepLike(curve: (u: number) => number): boolean {
	const n = 400;
	const span = Math.round(STEP_SPAN * n);
	const ys = Array.from({ length: n + 1 }, (_, i) => curve(i / n));
	for (let i = 0; i + span <= n; i++)
		if (Math.abs((ys[i + span] as number) - (ys[i] as number)) > STEP_JUMP)
			return true;
	return false;
}

/**
 * Control points of a fitted curve: x in [0, 1] as CSS requires, y in [0, 1] unless the motion goes past an end
 * value, then [-1, 2], which covers every back and overshoot curve in use.
 */
export function sanitizeBezier(
	x: readonly number[],
	overshoots: boolean,
): BezierParams {
	const [lo, hi] = overshoots ? [-1, 2] : [0, 1];
	return [
		clamp(x[0] as number, 0, 1),
		clamp(x[1] as number, lo, hi),
		clamp(x[2] as number, 0, 1),
		clamp(x[3] as number, lo, hi),
	];
}

/** Whether a bezier fits within what the readings show: no step, and no more overshoot than seen plus `margin`. */
export function plausibleBezier(
	p: BezierParams,
	seen: { under: number; over: number },
	margin: number,
): boolean {
	const curve = (u: number) => bezierY(p, u);
	const [lo, hi] = curveRange(curve);
	return (
		!isStepLike(curve) &&
		lo >= -seen.under - margin &&
		hi <= 1 + seen.over + margin
	);
}

/** The clip a fit must lie in: times of its first and last frame. */
export interface TimeBounds {
	firstMs: number;
	lastMs: number;
	frameMs: number;
}

const msText = (v: number) => `${Math.round(v * 10) / 10} ms`;

/**
 * Why a fitted timing cannot be the clip's motion, or null: the start lies within one frame before the first frame
 * and the last frame, the end within one frame after the last frame, and the duration is positive and no longer
 * than the clip plus a frame.
 */
export function timingProblem(
	startMs: number,
	durationMs: number,
	b: TimeBounds,
): string | null {
	const end = startMs + durationMs;
	const length = b.lastMs - b.firstMs;
	const clip = `the clip runs ${msText(b.firstMs)} to ${msText(b.lastMs)}`;
	if (!Number.isFinite(startMs) || !Number.isFinite(durationMs))
		return "the fit has no finite timing";
	if (durationMs <= 0) return `duration ${msText(durationMs)} is not positive`;
	if (durationMs > length + b.frameMs)
		return `duration ${msText(durationMs)} is longer than the clip (${msText(length)})`;
	if (startMs < b.firstMs - b.frameMs || startMs > b.lastMs)
		return `start ${msText(startMs)} is outside the clip; ${clip}`;
	if (end > b.lastMs + b.frameMs)
		return `end ${msText(end)} is after the clip; ${clip}`;
	return null;
}

/** Bounds of a series: its first and last sample, with its median frame gap. */
export function seriesBounds(
	series: readonly (readonly [number, number])[],
	frameMs: number,
): TimeBounds {
	return {
		firstMs: series[0]?.[0] ?? 0,
		lastMs: series.at(-1)?.[0] ?? 0,
		frameMs,
	};
}
