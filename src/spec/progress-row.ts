import type { Series } from "../measure/series.ts";
import { motionWindow } from "../measure/window.ts";
import type { ProgressWindow, Rect } from "../pixel/measure.ts";
import { supportOf } from "./confidence.ts";
import { START_SLACK_MS } from "./cross-check.ts";
import { curveDeviation } from "./deviation.ts";
import { candidateEasing } from "./easing.ts";
import { elementKey, type FittedMotion, fitMotion } from "./motion.ts";
import {
	DEFAULT_TOLERANCES,
	type Easing,
	PROGRESS,
	type SpecRow,
} from "./schema.ts";

export interface ProgressTiming {
	startMs: number;
	durationMs: number;
	easing: Easing;
	rmse: number;
	fit: FittedMotion;
	overshoot: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Number(v.toFixed(4));

/** Start, duration and easing of a progress series, fitted like any tracked row. */
export function progressTiming(series: Series): ProgressTiming | null {
	const window = motionWindow(series);
	if (!window) return null;
	const fit = fitMotion({ series, window });
	const easing = candidateEasing(fit.best);
	return {
		startMs: fit.best.delayMs,
		durationMs:
			easing.type === "spring" ? easing.settleMs : fit.best.durationMs,
		easing,
		rmse: fit.best.rmse,
		fit,
		overshoot: window.overshoot,
	};
}

export interface ProgressSource {
	selector: string;
	index: number;
	/** 1 for an element's first change, 2 for its second and so on. */
	ordinal: number;
	region: Rect;
	window: ProgressWindow;
}

const box = (r: Rect) =>
	`x ${Math.round(r.x)}, y ${Math.round(r.y)}, ${Math.round(r.w)}x${Math.round(r.h)}`;

export const progressId = (selector: string, index: number, ordinal: number) =>
	`${elementKey(selector, index)}.${PROGRESS}${ordinal > 1 ? `#${ordinal}` : ""}`;

/** A spec row for one change of an element's appearance, with confidence from its fit and sample count. */
export function progressRow(
	src: ProgressSource,
	noise: number,
	frameMs: number,
): SpecRow | null {
	const w = src.window;
	const timing = progressTiming(w.series);
	if (!timing) return null;
	const { support, confidence } = supportOf({
		obs: w.series.map(([t, v]) => ({ t, lo: v, hi: v })),
		startMs: timing.startMs,
		durationMs: timing.durationMs,
		rmse: timing.rmse,
		observed: 1,
		noise,
	});
	const timingTol = r1(frameMs + START_SLACK_MS);
	const residual = curveDeviation(
		timing.fit.samples,
		timing.fit.hint,
		timing.easing,
	).max;
	return {
		id: progressId(src.selector, src.index, src.ordinal),
		selector: src.selector,
		index: src.index,
		property: PROGRESS,
		from: 0,
		to: 1,
		fromObserved: true,
		startMs: r1(timing.startMs),
		durationMs: r1(timing.durationMs),
		easing: timing.easing,
		overshoot: r4(timing.overshoot),
		relativeDistance: null,
		source: "measured",
		confidence,
		support,
		rmse: Number(timing.rmse.toExponential(3)),
		easingResidual: Math.ceil(residual * 1e4) / 1e4,
		stagger: null,
		// Pixels place a change within a frame: timing is held to what the cross-check calls the same change.
		tolerances: {
			...DEFAULT_TOLERANCES,
			startMs: timingTol,
			endMs: timingTol,
			durationMs: timingTol,
		},
		notes: [
			`appearance progress from pixels in ${box(src.region)} (CSS px), between rest frames ${w.fromFrame} (${Math.round(w.fromMs)} ms) and ${w.toFrame} (${Math.round(w.toMs)} ms); mean RGB change ${w.distance.toFixed(1)}`,
		],
	};
}
