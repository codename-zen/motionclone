import { PROGRESS, type SpecRow, type StillEntry } from "../spec/schema.ts";
import type { CloneIndex, CloneMotion } from "./clone.ts";
import { curveMessage, curveMetric } from "./curve.ts";
import {
	type Evidence,
	evidenceMessage,
	evidenceMetric,
	firstSeenMs,
	PARTIAL_NOTE,
} from "./evidence.ts";
import {
	directionMessage,
	distanceMessage,
	missingMessage,
	overshootMessage,
	staticMessage,
	timingMessage,
	unitOf,
} from "./messages.ts";
import type { Metric, RowVerdict } from "./schema.ts";
import {
	checkTimingAndEasing,
	frameTol,
	metric,
	type StaggerAnchor,
	startFocus,
} from "./timing.ts";

export type { StaggerAnchor } from "./timing.ts";

type Moving = Extract<CloneMotion, { status: "moving" }>;

export function startMetric(row: SpecRow, c: Moving, frameMs: number): Metric {
	return metric(
		row.startMs,
		c.startMs,
		c.startMs - row.startMs,
		frameTol(row.tolerances.startMs, frameMs),
		"ms",
	);
}

// A start the reference never shows (drafted before its first reading) is only an upper bound: the clone must have
// started by the first reading; the shape after that is the evidence check's job.
function unseenStartMetric(
	row: SpecRow,
	c: Moving,
	frameMs: number,
	evidence: Evidence,
): Metric {
	const seen = firstSeenMs(evidence);
	const tol = frameTol(row.tolerances.startMs, frameMs);
	if (seen === null || row.startMs >= seen - frameMs)
		return startMetric(row, c, frameMs);
	const late = c.startMs - seen;
	return {
		want: row.startMs,
		got: c.startMs,
		diff: c.startMs - row.startMs,
		tol,
		unit: "ms",
		pass: late <= tol,
	};
}

export const isScale = (p: string) =>
	p === "scale" || p === "scaleX" || p === "scaleY";

export const logRatio = (from: number, to: number) =>
	from > 0 && to > 0 ? Math.abs(Math.log(to / from)) : Math.abs(to - from);

function verdictOf(
	row: { id: string; selector: string; index: number },
	kind: RowVerdict["kind"],
	property: string | null,
	metrics: Record<string, Metric>,
	failures: string[],
	focusMs: number[],
	notes: string[] = [],
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
		notes,
		advisory: null,
	};
}

export function checkMotionRow(
	row: SpecRow,
	c: CloneMotion,
	frameMs: number,
	anchor: StaggerAnchor | null,
	evidence: Evidence | null = null,
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

	const partial = !row.fromObserved && evidence !== null;
	const start = partial
		? unseenStartMetric(row, c, frameMs, evidence)
		: startMetric(row, c, frameMs);
	metrics.start = start;
	if (!start.pass) {
		failures.push(timingMessage(row, "start", start));
		focus.push(...startFocus(row, c));
	}
	if (partial) {
		const m = evidenceMetric(row, c, evidence);
		metrics.evidence = m;
		if (!m.pass) {
			failures.push(evidenceMessage(row, m));
			focus.push(...span);
		}
	} else {
		checkTimingAndEasing(row, c, frameMs, anchor, start, {
			metrics,
			failures,
			focus,
		});
		if (row.property === PROGRESS) {
			const { metric: curve, atMs } = curveMetric(row, c, frameMs);
			metrics.curve = curve;
			// A timing failure already says what is off; the curve only adds when timing alone passes.
			if (!curve.pass && failures.length === 0) {
				failures.push(curveMessage(row, curve, atMs));
				focus.push(atMs);
			}
		}
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
	// A scale is compared as a ratio: 1 -> 1.6 and 0.624 -> 1 are the same growth seen from different ends.
	const ratio = isScale(row.property) && !relative;
	const wantDist = ratio
		? logRatio(row.from, row.to)
		: relative
			? (row.relativeDistance as number)
			: Math.abs(row.to - row.from);
	const gotDist = ratio
		? logRatio(w.from, w.to)
		: relative
			? (w.relative as number)
			: Math.abs(w.change);
	if (!partial && wantDist > 0) {
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
		[...(partial ? [PARTIAL_NOTE] : []), ...(c.notes ?? [])],
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
