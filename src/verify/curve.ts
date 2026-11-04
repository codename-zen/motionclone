import { curveSpanMs, easingLabel, unitCurve } from "../spec/easing.ts";
import type { SpecRow } from "../spec/schema.ts";
import type { CloneMotion } from "./clone.ts";
import { movement, rowLabel } from "./messages.ts";
import type { Metric } from "./schema.ts";

type Moving = Extract<CloneMotion, { status: "moving" }>;

/**
 * Largest gap between the clone's readings and the spec curve on the same clock, for rows read from pixels
 * (ADR 0005): start, duration and shape errors that each stay inside their own tolerance still add up here.
 */
export function curveMetric(
	row: SpecRow,
	c: Moving,
	frameMs: number,
): { metric: Metric; atMs: number } {
	const curve = unitCurve(row.easing);
	const span = curveSpanMs(row.easing, row.durationMs);
	const change = row.to - row.from;
	const from = Math.min(row.startMs, c.startMs) - frameMs;
	const to =
		Math.max(row.startMs + row.durationMs, c.startMs + c.durationMs) + frameMs;
	let gap = 0;
	let atMs = row.startMs;
	for (const [t, v] of c.motion.series) {
		if (t < from || t > to) continue;
		const want = curve(Math.min(1, Math.max(0, (t - row.startMs) / span)));
		const d = Math.abs((v - row.from) / change - want);
		if (d > gap) {
			gap = d;
			atMs = t;
		}
	}
	const tol = row.tolerances.easing + row.easingResidual;
	return {
		metric: {
			want: 0,
			got: gap,
			diff: gap,
			tol,
			unit: "progress",
			pass: gap <= tol,
		},
		atMs,
	};
}

const num = (v: number) => Number(v.toFixed(3));

export const curveMessage = (row: SpecRow, m: Metric, atMs: number) =>
	`${rowLabel(row)} is ${num(m.got ?? 0)} off the spec curve at ${Math.round(atMs)} ms (want at most ${num(m.tol ?? 0)}): build ${movement(row.from, row.to)} from ${Math.round(row.startMs)} ms over ${Math.round(row.durationMs)} ms, ${easingLabel(row.easing)}`;
