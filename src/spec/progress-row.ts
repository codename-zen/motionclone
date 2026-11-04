import type { Series } from "../measure/series.ts";
import { motionWindow } from "../measure/window.ts";
import type { ProgressWindow, Rect, Span } from "../pixel/measure.ts";
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
	/** Set when the change was read between two backdrop flips. */
	span?: Span;
}

const box = (r: Rect) =>
	`x ${Math.round(r.x)}, y ${Math.round(r.y)}, ${Math.round(r.w)}x${Math.round(r.h)}${r.exclude?.length ? ` without the boxes of ${r.exclude.length} moving element${r.exclude.length === 1 ? "" : "s"}` : ""}`;

export const progressId = (selector: string, index: number, ordinal: number) =>
	`${elementKey(selector, index)}.${PROGRESS}${ordinal > 1 ? `#${ordinal}` : ""}`;

/** A change done within this many frames is a switch: no frame shows its shape. */
export const SWITCH_FRAMES = 2;

/** A switch row: the step a page takes in one go, as CSS `steps(1, end)` over the frames it falls between. */
export const SWITCH: Easing = { type: "steps", count: 1, position: "end" };

export const isSwitch = (row: Pick<SpecRow, "easing" | "property">) =>
	row.property === PROGRESS &&
	row.easing.type === "steps" &&
	row.easing.count === 1;

export const isSwitchWindow = (w: ProgressWindow) =>
	w.toFrame - w.fromFrame <= SWITCH_FRAMES;

// The rest frames on both sides pin a switch exactly: there is no curve to fit.
function switchTiming(w: ProgressWindow) {
	const rest = w.series.filter(([t]) => t <= w.fromMs || t >= w.toMs).length;
	return {
		startMs: w.fromMs,
		durationMs: w.toMs - w.fromMs,
		easing: SWITCH,
		rmse: 0,
		residual: 0,
		overshoot: 0,
		confidence: rest >= 6 ? ("high" as const) : ("medium" as const),
		support: { samples: rest, rmse: 0, observed: 1, quality: null, weak: [] },
	};
}

function fittedTiming(w: ProgressWindow, noise: number) {
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
	const residual = curveDeviation(
		timing.fit.samples,
		timing.fit.hint,
		timing.easing,
	).max;
	return { ...timing, residual, support, confidence };
}

/** A spec row for one change of an element's appearance, with confidence from its fit and sample count. */
export function progressRow(
	src: ProgressSource,
	noise: number,
	frameMs: number,
): SpecRow | null {
	const w = src.window;
	const timing = isSwitchWindow(w) ? switchTiming(w) : fittedTiming(w, noise);
	if (!timing) return null;
	const { support, confidence, residual } = timing;
	const timingTol = r1(frameMs + START_SLACK_MS);
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
		distanceObserved: "full",
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
			`appearance progress from pixels in ${box(src.region)} (CSS px), between rest frames ${w.fromFrame} (${Math.round(w.fromMs)} ms) and ${w.toFrame} (${Math.round(w.toMs)} ms); mean RGB change ${w.distance.toFixed(1)}${isSwitchWindow(w) ? "; a near-instant switch" : ""}`,
			...(src.span
				? [
						`read between ${Math.round(src.span.firstMs)} and ${Math.round(src.span.lastMs)} ms, where light and dark behind the element are swapped`,
					]
				: []),
		],
		...(src.span ? { within: { ...src.span } } : {}),
	};
}
