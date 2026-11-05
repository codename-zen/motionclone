import { isSwitch } from "../spec/progress-row.ts";
import { PROGRESS, type SpecRow, type StillEntry } from "../spec/schema.ts";
import type { CloneIndex, CloneMotion } from "./clone.ts";
import { curveMessage, curveMetric } from "./curve.ts";
import { distanceCheck } from "./distance.ts";
import {
	type Evidence,
	evidenceMessage,
	evidenceMetric,
	firstSeenMs,
	PARTIAL_NOTE,
	UNSEEN_END_NOTE,
} from "./evidence.ts";
import {
	directionMessage,
	missingMessage,
	movement,
	overshootMessage,
	staticMessage,
	timingMessage,
} from "./messages.ts";
import { countMessage, unpairedMessage } from "./motion-count.ts";
import type { Metric, RowVerdict } from "./schema.ts";
import {
	checkTimingAndEasing,
	frameTol,
	metric,
	type StaggerAnchor,
	startFocus,
} from "./timing.ts";

export { isScale, logRatio } from "./distance.ts";
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
				: c.count
					? c.count.got < c.count.want
						? countMessage(row, c.count.got, c.count.want)
						: unpairedMessage(row)
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

	const partial = (!row.fromObserved || !row.toObserved) && evidence !== null;
	const endUnseen = partial && !row.toObserved;
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
		if (row.property === PROGRESS && !isSwitch(row)) {
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
	if (!endUnseen) metrics.overshoot = overshoot;
	if (!endUnseen && !overshoot.pass) {
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

	const distance = partial ? null : distanceCheck(row, c);
	if (distance) {
		metrics.distance = distance.metric;
		if (distance.failure && metrics.direction?.pass !== false) {
			failures.push(distance.failure);
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
		[
			...(partial ? [endUnseen ? UNSEEN_END_NOTE : PARTIAL_NOTE] : []),
			...(distance?.note ? [distance.note] : []),
			...(c.notes ?? []),
		],
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
							`${m.property} ${movement(m.window.from, m.window.to)} from ${Math.round(m.window.startMs)} ms`,
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
