import { describe, expect, it } from "vitest";
import { SpecRow } from "../src/spec/schema.ts";
import type { CloneMotion } from "../src/verify/clone.ts";
import { distanceMessage } from "../src/verify/messages.ts";
import { isScale, logRatio } from "../src/verify/rows.ts";

const row = SpecRow.parse({
	id: "card[0].scale",
	selector: "card",
	index: 0,
	property: "scale",
	from: 1,
	to: 1.6,
	startMs: 640,
	durationMs: 310,
	easing: { type: "cubic-bezier", p: [0.4, 0, 0.2, 1], name: null },
	overshoot: 0,
	relativeDistance: null,
	source: "measured",
	confidence: "medium",
	rmse: 0.01,
	stagger: null,
});

const moving = (from: number, to: number) =>
	({
		status: "moving",
		motion: { window: { from, to, change: to - from } },
	}) as unknown as Extract<CloneMotion, { status: "moving" }>;

describe("scale distance as a ratio", () => {
	it("treats a growth seen from either end as the same distance", () => {
		expect(logRatio(1, 1.6)).toBeCloseTo(logRatio(0.625, 1), 6);
		expect(isScale("scale")).toBe(true);
		expect(isScale("opacity")).toBe(false);
	});

	it("names the growth factor in the message", () => {
		const want = logRatio(row.from, row.to);
		const got = logRatio(0.8, 1);
		const m = distanceMessage(row, moving(0.8, 1), {
			want,
			got,
			diff: got / want - 1,
			tol: 0.1,
			unit: "",
			pass: false,
		});
		expect(m).toBe("card[0] scale grows 1.25x (want 1.6x, 53 % short)");
	});
});
