import { curveDeviation } from "../spec/deviation.ts";
import { isSwitch } from "../spec/progress-row.ts";
import type { SpecRow } from "../spec/schema.ts";
import type { CloneMotion } from "./clone.ts";
import { easingMessage, staggerMessage, timingMessage } from "./messages.ts";
import type { Metric } from "./schema.ts";

type Moving = Extract<CloneMotion, { status: "moving" }>;

/** The previous stagger sibling's measured start, when its own start is within tolerance. */
export interface StaggerAnchor {
	startMs: number;
	startPass: boolean;
}

export const metric = (
	want: number,
	got: number,
	diff: number,
	tol: number,
	unit: string,
): Metric => ({ want, got, diff, tol, unit, pass: Math.abs(diff) <= tol });

export const frameTol = (tol: number, frameMs: number) =>
	Math.max(tol, frameMs);

// Moments where one side has started and the other has not, then shortly after the later start.
export function startFocus(row: SpecRow, c: Moving): number[] {
	const later = Math.max(row.startMs, c.startMs);
	return [(row.startMs + c.startMs) / 2, later, later + row.durationMs / 4];
}

interface Collect {
	metrics: Record<string, Metric>;
	failures: string[];
	focus: number[];
}

/** Stagger, duration, end and easing against the spec numbers, for rows whose whole motion the reference shows. */
export function checkTimingAndEasing(
	row: SpecRow,
	c: Moving,
	frameMs: number,
	anchor: StaggerAnchor | null,
	start: Metric,
	{ metrics, failures, focus }: Collect,
): void {
	const tol = row.tolerances;
	const end = row.startMs + row.durationMs;
	const duration = metric(
		row.durationMs,
		c.durationMs,
		c.durationMs - row.durationMs,
		frameTol(tol.durationMs, frameMs),
		"ms",
	);
	const gotEnd = c.startMs + c.durationMs;
	const endM = metric(
		end,
		gotEnd,
		gotEnd - end,
		frameTol(tol.endMs, frameMs),
		"ms",
	);
	Object.assign(metrics, { duration, end: endM });
	if (row.stagger && anchor?.startPass) {
		const gap = c.startMs - anchor.startMs;
		const m = metric(
			row.stagger.gapMs,
			gap,
			gap - row.stagger.gapMs,
			frameTol(tol.staggerMs, frameMs),
			"ms",
		);
		metrics.stagger = m;
		if (!m.pass) {
			failures.push(staggerMessage(row, m));
			focus.push(...startFocus(row, c));
		}
	}
	if (!duration.pass) failures.push(timingMessage(row, "duration", duration));
	// A late start or a long run already explains a late end.
	if (!endM.pass && start.pass && duration.pass)
		failures.push(timingMessage(row, "end", endM));
	if (!duration.pass || (!endM.pass && start.pass)) focus.push(end, gotEnd);
	// A switch has no shape between its two frames; its duration says whether the clone fades instead.
	if (isSwitch(row)) return;

	const dev = curveDeviation(c.fit.samples, c.fit.hint, row.easing);
	// The clone cannot be held closer to the spec curve than the reference itself is.
	const easingTol = tol.easing + row.easingResidual;
	const easing: Metric = {
		want: 0,
		got: dev.max,
		diff: dev.max,
		tol: easingTol,
		unit: "progress",
		pass: dev.max <= easingTol,
	};
	metrics.easing = easing;
	if (!easing.pass) {
		failures.push(easingMessage(row, c, easing));
		focus.push(dev.atMs, row.startMs + row.durationMs / 4);
	}
}
