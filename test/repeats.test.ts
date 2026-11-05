import { describe, expect, it } from "vitest";
import { markRepeats } from "../src/video/repeats.ts";
import type { RegionSample } from "../src/video/samples.ts";

/** Samples at the given x positions, with the region's change into each frame proportional to the step. */
const samples = (xs: number[]) =>
	xs.map(
		(x, k) =>
			({
				found: true,
				dx: x,
				dy: 0,
				energy: k === 0 ? 0 : 2 * Math.abs(x - (xs[k - 1] as number)),
				repeat: false,
			}) as RegionSample,
	);

describe("repeated frames in a recording", () => {
	it("marks a frame that repeats the one before while the element moves on", () => {
		const s = samples([0, 10, 20, 20, 40, 50, 60]);
		expect(markRepeats(s)).toEqual([3]);
		expect(s[3]?.repeat).toBe(true);
	});

	it("leaves a turn (an overshoot) and a rest alone", () => {
		expect(markRepeats(samples([0, 10, 20, 20, 10, 0, 0]))).toEqual([]);
		expect(markRepeats(samples([0, 10, 20, 20, 20, 20, 20]))).toEqual([]);
	});
});
