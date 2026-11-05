import type { TimeBounds } from "../fit/plausible.ts";
import type { Observation } from "../fit/types.ts";
import {
	MIN_RANGE,
	type MovingProperty,
	type Track,
} from "../measure/elements.ts";
import { endsUnseen } from "../measure/segments.ts";
import { extractSeries, type Series } from "../measure/series.ts";
import { bezierEasing } from "./easing.ts";
import {
	boundLeadingFills,
	type ObservationModel,
	type Observed,
} from "./observe.ts";
import { fitPartialRows, type PartialFit } from "./partial.ts";
import type { Easing } from "./schema.ts";

// Box readings stop where the tracker lost the element; scale and blur also stop where it only stopped measuring them.
const BOX = new Set(["x", "y", "width", "height"]);

/** The motion breaks off while it still moves, as an element that fades, morphs or leaves its region mid-move. */
export function endUnseen(track: Track, m: MovingProperty): boolean {
	if (!BOX.has(m.property)) return false;
	const series = extractSeries(track.frames, m.selector, m.index, m.property);
	return endsUnseen(
		series,
		m.series,
		MIN_RANGE[m.property],
		track.frameMs,
		track.frames.at(-1)?.t ?? 0,
	);
}

export interface UnseenEndItem {
	m: MovingProperty;
	observed: Observed;
}

// Time runs backwards in the mirrored fit: t becomes -t, so the unseen end becomes an unseen start (ADR 0003).
const flipSeries = (s: Series): Series =>
	s.map(([t, v]) => [-t, v] as const).reverse();

/** Readings up to the motion's last one, mirrored; positions held after the element was lost are not readings. */
function flipObs(obs: readonly Observation[], lastMs: number): Observation[] {
	const out = obs
		.filter((o) => o.t <= lastMs)
		.map((o) => ({ ...o, t: -o.t }))
		.reverse();
	// Positions filled in after the element left (cut at the region edge) bound the end on the far side only.
	boundLeadingFills(out);
	return out;
}

function flipMotion(m: MovingProperty): MovingProperty {
	const w = m.window;
	return {
		...m,
		series: flipSeries(m.series),
		window: {
			...w,
			startMs: -w.endMs,
			endMs: -w.startMs,
			from: w.to,
			to: w.from,
			change: -w.change,
			peak: w.from,
			peakMs: -w.startMs,
			overshoot: 0,
		},
		...(m.within
			? { within: { firstMs: -m.within.lastMs, lastMs: -m.within.firstMs } }
			: {}),
	};
}

/** A cubic-bezier run backwards: the same curve with time and progress mirrored. */
function reversed(e: Easing): Easing {
	if (e.type !== "cubic-bezier") return e;
	const [x1, y1, x2, y2] = e.p;
	return bezierEasing([1 - x2, 1 - y2, 1 - x1, 1 - y1]);
}

export interface UnseenEndFit extends PartialFit {
	/** Fitted end value, not seen. */
	to: number;
}

const round = (v: number) => Number(v.toFixed(3));

/**
 * Motions whose end the reference never shows, fitted like an unseen start (ADR 0003) on the readings mirrored in
 * time: the start value is seen, the end value is solved for.
 */
export function fitUnseenEnds(
	items: readonly UnseenEndItem[],
	frameMs: number,
	model: ObservationModel,
	clip?: TimeBounds,
): Map<MovingProperty, UnseenEndFit> {
	const mirrored = items.map((i) => ({
		source: i,
		m: flipMotion(i.m),
		observed: {
			obs: flipObs(i.observed.obs, i.m.series.at(-1)?.[0] ?? 0),
			fromObserved: false,
			boundedStart: false,
		},
	}));
	const fits = fitPartialRows(
		mirrored,
		frameMs,
		model,
		clip && { ...clip, firstMs: -clip.lastMs, lastMs: -clip.firstMs },
	);
	const out = new Map<MovingProperty, UnseenEndFit>();
	for (const { source, m } of mirrored) {
		const f = fits.get(m);
		if (!f) continue;
		const lastPlain = source.observed.obs.findLast((o) => o.lo === o.hi);
		out.set(source.m, {
			...f,
			startMs: -(f.startMs + f.durationMs),
			easing: reversed(f.easing),
			from: source.m.window.from,
			to: f.from,
			weak: f.weak.map((w) => w.replace("start value", "end value")),
			notes: [
				`end value not visible in the reference: ${round(f.from)} is extrapolated from the readings${lastPlain ? ` up to ${Math.round(lastPlain.t)} ms` : ""}; verify checks the clone against the visible readings`,
				...f.notes.slice(1),
			],
		});
	}
	return out;
}
