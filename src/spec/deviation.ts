import { curveRmse, fitTiming } from "../fit/bezier.ts";
import type { Hint, Sample } from "../fit/types.ts";
import { unitCurve } from "./easing.ts";
import type { Easing } from "./schema.ts";

export interface CurveDeviation {
	/** Largest |progress - curve| over the samples, with timing fitted freely so only the shape counts. */
	max: number;
	/** Sample time of the largest gap. */
	atMs: number;
	rmse: number;
}

/** Deviation of samples from an easing, with that easing's best start and span. */
export function curveDeviation(
	samples: readonly Sample[],
	hint: Hint,
	easing: Easing,
	timing?: { delayMs: number; spanMs: number },
): CurveDeviation {
	const curve = unitCurve(easing);
	const fit = timing
		? {
				delayMs: timing.delayMs,
				durationMs: timing.spanMs,
				rmse: curveRmse(samples, curve, timing.delayMs, timing.spanMs),
			}
		: fitTiming(samples, hint, curve);
	let max = 0;
	let atMs = hint.startMs;
	for (const [t, p] of samples) {
		const u = Math.min(1, Math.max(0, (t - fit.delayMs) / fit.durationMs));
		const d = p - curve(u);
		if (Math.abs(d) > max) {
			max = Math.abs(d);
			atMs = t;
		}
	}
	return {
		max,
		atMs,
		rmse: fit.rmse,
	};
}
