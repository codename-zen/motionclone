import { describe, expect, it } from "vitest";
import type { MotionWindow } from "../src/measure/window.ts";
import { SpecRow } from "../src/spec/schema.ts";
import type { CloneMotion } from "../src/verify/clone.ts";
import type { Evidence } from "../src/verify/evidence.ts";
import { checkMotionRow } from "../src/verify/rows.ts";

const FRAME = 1000 / 60;
const outQuad = (u: number) => 1 - (1 - u) ** 2;

// Blur 24 -> 0 starting at `start`, over 226 ms, sampled every frame up to 1400 ms.
const blurSeries = (start: number) =>
	Array.from({ length: 85 }, (_, k) => {
		const t = k * FRAME;
		const u = Math.min(1, Math.max(0, (t - start) / 226));
		return [t, 24 * (1 - outQuad(u))] as const;
	});

const windowOf = (start: number): MotionWindow =>
	({
		startMs: start,
		endMs: start + 226,
		durationMs: 226,
		from: 24,
		to: 0,
		change: -24,
		peak: 24,
		peakMs: start,
		overshoot: 0,
		thereAndBack: false,
		relative: null,
	}) as MotionWindow;

const clone = (start: number): CloneMotion => ({
	status: "moving",
	motion: {
		window: windowOf(start),
		series: blurSeries(start),
	},
	fit: {} as never,
	startMs: start,
	durationMs: 226,
	easing: { type: "linear" },
});

// The reference shows the element from 672 ms on; earlier frames carry no blur reading.
const evidence: Evidence = {
	obs: blurSeries(672)
		.filter(([t]) => t >= 672)
		.map(([t, v]) => ({ t, lo: v, hi: v })),
	span: 24,
};

// Drafted with its start in the unseen part: an in-out curve from 589 ms that the readings cannot place exactly.
const row = SpecRow.parse({
	id: "art[0].blur",
	selector: "art",
	index: 0,
	property: "blur",
	from: 24,
	to: 0,
	startMs: 589,
	durationMs: 306,
	easing: { type: "cubic-bezier", p: [0.65, 0, 0.35, 1], name: null },
	overshoot: 0,
	relativeDistance: null,
	source: "measured",
	confidence: "medium",
	rmse: 0.01,
	stagger: null,
	fromObserved: false,
});

describe("a start the reference never shows", () => {
	it("passes a clone that starts when the reference first shows the motion", () => {
		const v = checkMotionRow(row, clone(672), FRAME, null, evidence);
		expect(v.failures.filter((f) => f.includes("starts"))).toEqual([]);
		expect(v.metrics.start?.pass).toBe(true);
	});

	it("fails a clone that starts well after the reference shows the motion", () => {
		const v = checkMotionRow(row, clone(900), FRAME, null, evidence);
		expect(v.metrics.start?.pass).toBe(false);
		expect(v.pass).toBe(false);
	});

	it("still checks the exact start when the drafted start is inside the readings", () => {
		const seenRow = SpecRow.parse({ ...row, startMs: 700 });
		const v = checkMotionRow(seenRow, clone(820), FRAME, null, evidence);
		expect(v.metrics.start?.pass).toBe(false);
	});
});
