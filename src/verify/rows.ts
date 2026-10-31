import { curveDeviation } from "../spec/deviation.ts";
import type { SpecRow, StillEntry } from "../spec/schema.ts";
import type { CloneIndex, CloneMotion } from "./clone.ts";
import {
	directionMessage,
	distanceMessage,
	easingMessage,
	missingMessage,
	overshootMessage,
	staggerMessage,
	staticMessage,
	timingMessage,
	unitOf,
} from "./messages.ts";
import type { Metric, RowVerdict } from "./schema.ts";

type Moving = Extract<CloneMotion, { status: "moving" }>;

/** The previous stagger sibling's measured start, when its own start is within tolerance. */
export interface StaggerAnchor {
	startMs: number;
	startPass: boolean;
}

const metric = (
	want: number,
	got: number,
	diff: number,
	tol: number,
	unit: string,
): Metric => ({ want, got, diff, tol, unit, pass: Math.abs(diff) <= tol });

const frameTol = (tol: number, frameMs: number) => Math.max(tol, frameMs);

export function startMetric(row: SpecRow, c: Moving, frameMs: number): Metric {
	return metric(
		row.startMs,
		c.startMs,
		c.startMs - row.startMs,
		frameTol(row.tolerances.startMs, frameMs),
		"ms",
	);
}

function verdictOf(
	row: { id: string; selector: string; index: number },
	kind: RowVerdict["kind"],
	property: string | null,
	metrics: Record<string, Metric>,
	failures: string[],
	focusMs: number[],
): RowVerdict {
	const pass = failures.length === 0;
	return {
		id: row.id,
		kind,
		selector: row.selector,
		index: row.index,
		property,
		pass,
		metrics,
		failures,
		message: pass ? `${row.id} matches the spec` : failures.join("; "),
		focusMs: [...new Set(focusMs.map((t) => Math.round(t)))],
	};
}

// Moments where one side has started and the other has not, then shortly after the later start.
function startFocus(row: SpecRow, c: Moving): number[] {
	const later = Math.max(row.startMs, c.startMs);
	return [(row.startMs + c.startMs) / 2, later, later + row.durationMs / 4];
}

export function checkMotionRow(
	row: SpecRow,
	c: CloneMotion,
	frameMs: number,
	anchor: StaggerAnchor | null,
): RowVerdict {
	const end = row.startMs + row.durationMs;
	const span = [row.startMs, row.startMs + row.durationMs / 2, end];
	if (c.status !== "moving") {
		const failure =
			c.status === "missing"
				? missingMessage(row.selector, row.index, c.matched)
				: staticMessage(row, c.standIns);
		const present: Metric = {
			want: 1,
			got: 0,
			diff: null,
			tol: null,
			unit: "",
			pass: false,
		};
		return verdictOf(
			row,
			"motion",
			row.property,
			{ [c.status === "missing" ? "present" : "moves"]: present },
			[failure],
			span,
		);
	}
	const tol = row.tolerances;
	const w = c.motion.window;
	const metrics: Record<string, Metric> = {};
	const failures: string[] = [];
	const focus: number[] = [];

	const start = startMetric(row, c, frameMs);
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
	Object.assign(metrics, { start, duration, end: endM });
	if (!start.pass) {
		failures.push(timingMessage(row, "start", start));
		focus.push(...startFocus(row, c));
	}
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

	const dev = curveDeviation(c.fit.samples, c.fit.hint, row.easing);
	const easing: Metric = {
		want: 0,
		got: dev.max,
		diff: dev.max,
		tol: tol.easing,
		unit: "progress",
		pass: dev.max <= tol.easing,
	};
	metrics.easing = easing;
	if (!easing.pass) {
		failures.push(easingMessage(row, c, easing));
		focus.push(dev.atMs, row.startMs + row.durationMs / 4);
	}

	const overshoot = metric(
		row.overshoot * 100,
		w.overshoot * 100,
		(w.overshoot - row.overshoot) * 100,
		tol.overshootPp,
		"%",
	);
	metrics.overshoot = overshoot;
	if (!overshoot.pass) {
		failures.push(overshootMessage(row, overshoot));
		focus.push(w.peakMs);
	}

	const wantDir = Math.sign(row.to - row.from);
	if (wantDir !== 0) {
		const gotDir = Math.sign(w.change);
		const direction: Metric = {
			want: wantDir,
			got: gotDir,
			diff: null,
			tol: null,
			unit: "sign",
			pass: wantDir === gotDir,
		};
		metrics.direction = direction;
		if (!direction.pass) {
			failures.push(directionMessage(row, c));
			focus.push(end);
		}
	}

	const relative = row.relativeDistance !== null && w.relative !== null;
	const wantDist = relative
		? (row.relativeDistance as number)
		: Math.abs(row.to - row.from);
	const gotDist = relative ? (w.relative as number) : Math.abs(w.change);
	if (wantDist > 0) {
		const distance = metric(
			wantDist,
			gotDist,
			gotDist / wantDist - 1,
			tol.distance,
			relative ? "of size" : unitOf(row.property).trim(),
		);
		metrics.distance = distance;
		if (!distance.pass && metrics.direction?.pass !== false) {
			failures.push(distanceMessage(row, c, distance));
			focus.push(end);
		}
	}
	return verdictOf(
		row,
		"motion",
		row.property,
		metrics,
		failures,
		focus.length ? focus : span,
	);
}

export function checkStill(entry: StillEntry, idx: CloneIndex): RowVerdict {
	if (!idx.present.has(entry.id))
		return verdictOf(
			entry,
			"still",
			null,
			{
				present: {
					want: 1,
					got: 0,
					diff: null,
					tol: null,
					unit: "",
					pass: false,
				},
			},
			[
				missingMessage(
					entry.selector,
					entry.index,
					idx.matched.get(entry.selector) ?? 0,
				),
			],
			[0],
		);
	const moving = idx.byElement.get(entry.id) ?? [];
	const motion: Metric = {
		want: 0,
		got: moving.length,
		diff: moving.length,
		tol: 0,
		unit: "moving properties",
		pass: moving.length === 0,
	};
	const failures = moving.length
		? [
				`${entry.id} should stay still but moves: ${moving
					.map(
						(m) =>
							`${m.property} ${Number(m.window.from.toFixed(3))} -> ${Number(m.window.to.toFixed(3))} from ${Math.round(m.window.startMs)} ms`,
					)
					.join(", ")}; remove that animation`,
			]
		: [];
	const first = moving[0]?.window;
	return verdictOf(
		entry,
		"still",
		null,
		{ motion },
		failures,
		first
			? [first.startMs, (first.startMs + first.endMs) / 2, first.endMs]
			: [0],
	);
}
