import { boundsRmse, visibleChange } from "../fit/joint.ts";
import type { Track } from "../measure/elements.ts";
import type { Property } from "../measure/series.ts";
import { valueAt } from "../measure/series.ts";
import { curveSpanMs, unitCurve } from "../spec/easing.ts";
import { type ObservationModel, observe } from "../spec/observe.ts";
import type { SpecRow } from "../spec/schema.ts";
import type { CloneMotion } from "./clone.ts";
import { rowLabel } from "./messages.ts";
import type { Metric } from "./schema.ts";

type Moving = Extract<CloneMotion, { status: "moving" }>;

// A clone may sit this much further (rms, in units of the visible change) from the reference readings than the
// spec curve does: the reading noise of a video (ADR 0003).
export const EVIDENCE_TOL = 0.04;

export const PARTIAL_NOTE =
	"start value not visible in the reference: duration, easing, stagger and distance are checked against the readings it does show";

/** Reference readings a partly observed row is checked against, and the scale of their residuals. */
export interface Evidence {
	obs: ReturnType<typeof observe>["obs"];
	span: number;
}

export function evidenceOf(
	track: Track,
	row: SpecRow,
	model: ObservationModel,
): Evidence {
	const { obs } = observe(
		track,
		row.selector,
		row.index,
		row.property as Property,
		model,
	);
	return { obs, span: visibleChange(obs, row.to) };
}

/**
 * How far the clone's own values, placed at the reference's end value, fall outside the reference readings,
 * against how far the spec curve does. Absolute times, so start, stagger, duration, easing and the visible
 * distance all count.
 */
export function evidenceMetric(row: SpecRow, c: Moving, ev: Evidence): Metric {
	const curve = unitCurve(row.easing);
	const spanMs = curveSpanMs(row.easing, row.durationMs);
	const spec = (t: number) =>
		row.to + (row.from - row.to) * (1 - curve((t - row.startMs) / spanMs));
	const clone = (t: number) =>
		row.to + valueAt(c.motion.series, t) - c.motion.window.to;
	const want = boundsRmse(ev.obs, spec, ev.span);
	const got = boundsRmse(ev.obs, clone, ev.span);
	return {
		want,
		got,
		diff: got - want,
		tol: EVIDENCE_TOL,
		unit: "rms of visible change",
		pass: got - want <= EVIDENCE_TOL,
	};
}

/** Time of the first reading that bounds the value on both sides; earlier the reference shows nothing of this row. */
export function firstSeenMs(ev: Evidence): number | null {
	const o = ev.obs.find((x) => Number.isFinite(x.lo) && Number.isFinite(x.hi));
	return o ? o.t : null;
}

const num = (v: number) => Number(v.toFixed(3));

export const evidenceMessage = (row: SpecRow, m: Metric) =>
	`${rowLabel(row)} does not match the part of the motion the reference shows: rms gap ${num(m.got ?? 0)} of the visible change, the spec curve has ${num(m.want ?? 0)}; build ${num(row.from)} -> ${num(row.to)} from ${Math.round(row.startMs)} ms over ${Math.round(row.durationMs)} ms`;
