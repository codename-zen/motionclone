import type { Series } from "../measure/series.ts";
import { curveSpanMs, easingLabel, unitCurve } from "./easing.ts";
import type { DraftedProgress } from "./progress.ts";
import { PROGRESS, type SpecRow } from "./schema.ts";

// Two measurements of one change disagree when their starts differ by more than a frame plus this, or their
// curves by more than the easing tolerance (ADR 0005).
export const START_SLACK_MS = 20;
export const CURVE_GAP = 0.05;
// The pixel curve fits clearly better when the row's curve sits at least this many times further from the
// pixels, and this much further in absolute terms.
const CLEARLY_TIMES = 2;
const CLEARLY_BY = 0.02;
// Rows cover the same window when they overlap by this share of the shorter one.
const SAME_WINDOW = 0.5;

type Level = SpecRow["confidence"];
const LEVELS: Level[] = ["low", "medium", "high"];
const lower = (a: Level, b: Level) =>
	LEVELS.indexOf(a) <= LEVELS.indexOf(b) ? a : b;

const endOf = (r: SpecRow) => r.startMs + r.durationMs;

function timed(r: SpecRow): (t: number) => number {
	const curve = unitCurve(r.easing);
	const span = curveSpanMs(r.easing, r.durationMs);
	return (t) => curve(Math.min(1, Math.max(0, (t - r.startMs) / span)));
}

function overlapShare(a: SpecRow, b: SpecRow): number {
	const overlap = Math.min(endOf(a), endOf(b)) - Math.max(a.startMs, b.startMs);
	const shorter = Math.max(1, Math.min(a.durationMs, b.durationMs));
	return overlap / shorter;
}

export interface Comparison {
	startGapMs: number;
	/** Largest gap between the two timed curves, in progress. */
	curveGap: number;
	/** rms of each row's curve against the pixel progress readings. */
	rmsRow: number;
	rmsProgress: number;
	agree: boolean;
	/** The pixel curve fits its readings clearly better than the row's curve does. */
	clearlyWorse: boolean;
}

/** How a tracked row's timing and shape compare with a progress row of the same change. */
export function compareWithProgress(
	row: SpecRow,
	progress: SpecRow,
	series: Series,
	frameMs: number,
): Comparison {
	const a = timed(row);
	const b = timed(progress);
	const from = Math.min(row.startMs, progress.startMs) - frameMs;
	const to = Math.max(endOf(row), endOf(progress)) + frameMs;
	let curveGap = 0;
	for (let t = from; t <= to; t++)
		curveGap = Math.max(curveGap, Math.abs(a(t) - b(t)));
	const inside = series.filter(([t]) => t >= from && t <= to);
	const rms = (f: (t: number) => number) =>
		Math.sqrt(
			inside.reduce((s, [t, v]) => s + (f(t) - v) ** 2, 0) /
				Math.max(1, inside.length),
		);
	const startGapMs = Math.abs(row.startMs - progress.startMs);
	const rmsRow = rms(a);
	const rmsProgress = rms(b);
	return {
		startGapMs,
		curveGap,
		rmsRow,
		rmsProgress,
		agree: startGapMs <= frameMs + START_SLACK_MS && curveGap <= CURVE_GAP,
		clearlyWorse:
			rmsRow >= CLEARLY_TIMES * rmsProgress &&
			rmsRow - rmsProgress >= CLEARLY_BY,
	};
}

const ms = (v: number) => Math.round(v);
const num = (v: number) => Number(v.toFixed(3));
const timing = (r: SpecRow) =>
	`${ms(r.startMs)} ms over ${ms(r.durationMs)} ms, ${easingLabel(r.easing)}`;

function setConfidence(row: SpecRow, level: Level, reason: string): void {
	row.confidence = level;
	if (level === "low" && row.support)
		row.support = { ...row.support, weak: [...row.support.weak, reason] };
}

/**
 * Cross-check each opacity row against a progress row of the same element and window (ADR 0005):
 * disagreeing rows drop to medium at most, or low when the pixel curve fits clearly better, and rows that share
 * their timing follow; agreeing rows that are medium become high. Notes name both measurements.
 */
export function crossCheck(
	rows: SpecRow[],
	progress: readonly DraftedProgress[],
	frameMs: number,
): void {
	for (const { row: p, series } of progress) {
		const tracked = rows.filter(
			(r) =>
				r.property === "opacity" &&
				r.selector === p.selector &&
				r.index === p.index &&
				overlapShare(r, p) >= SAME_WINDOW,
		);
		for (const o of tracked) {
			const c = compareWithProgress(o, p, series, frameMs);
			const numbers = `${o.id} ${timing(o)}; ${p.id} ${timing(p)}; start gap ${ms(c.startGapMs)} ms, curve gap ${num(c.curveGap)}, rms against the pixels ${num(c.rmsRow)} vs ${num(c.rmsProgress)}`;
			if (c.agree) {
				if (o.confidence === "medium") o.confidence = "high";
				o.notes.push(`pixel progress agrees: ${numbers}`);
				p.notes.push(`agrees with ${o.id}`);
				continue;
			}
			const level = c.clearlyWorse ? "low" : lower(o.confidence, "medium");
			const reason = `pixel progress disagrees: ${numbers}`;
			const followers = rows.filter(
				(r) =>
					r !== o &&
					r.property !== PROGRESS &&
					r.selector === o.selector &&
					r.index === o.index &&
					r.startMs === o.startMs &&
					r.durationMs === o.durationMs,
			);
			setConfidence(o, lower(o.confidence, level), reason);
			o.notes.push(reason);
			for (const f of followers) {
				const why = `timing shared with ${o.id}; ${reason}`;
				setConfidence(f, lower(f.confidence, level), why);
				f.notes.push(why);
			}
			p.notes.push(`disagrees with ${o.id}`);
		}
	}
}
