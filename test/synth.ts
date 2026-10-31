import { bezierY } from "../src/fit/bezier.ts";
import type { BezierParams } from "../src/fit/presets.ts";
import { type Spring, springResponse } from "../src/fit/spring.ts";
import { stepsY } from "../src/fit/steps.ts";
import type { Series } from "../src/measure/series.ts";

export const FRAME_MS = 1000 / 60;

function rng(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Gaussian noise as a fraction of the total change, seeded. */
export function sample(
	curve: (t: number) => number,
	{ from = 0, to = 100, lengthMs = 1500, noise = 0, seed = 7 } = {},
): Series {
	const rand = rng(seed);
	const gauss = () =>
		Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
	const out: Series = [];
	for (let k = 0; k * FRAME_MS <= lengthMs; k++) {
		const t = Math.round(k * FRAME_MS);
		out.push([t, from + (to - from) * (curve(t) + noise * gauss())]);
	}
	return out;
}

export const bezierCurve =
	(p: BezierParams, delayMs: number, durationMs: number) => (t: number) =>
		bezierY(p, (t - delayMs) / durationMs);

export const springCurve = (s: Spring, delayMs: number) => (t: number) =>
	springResponse(s, (t - delayMs) / 1000);

export const stepsCurve =
	(n: number, pos: "start" | "end", delayMs: number, durationMs: number) =>
	(t: number) =>
		stepsY(n, pos, (t - delayMs) / durationMs);

/** Largest gap between two timed unit curves over a time range. */
export function maxDeviation(
	a: (t: number) => number,
	b: (t: number) => number,
	fromMs: number,
	toMs: number,
): number {
	let worst = 0;
	for (let t = fromMs; t <= toMs; t += 1)
		worst = Math.max(worst, Math.abs(a(t) - b(t)));
	return worst;
}
