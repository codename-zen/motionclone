import { describe, expect, it } from "vitest";
import { bezierY } from "../src/fit/bezier.ts";
import { fitJoint } from "../src/fit/joint.ts";
import {
	curveRange,
	isStepLike,
	plausibleBezier,
	sanitizeBezier,
} from "../src/fit/plausible.ts";
import { PRESETS } from "../src/fit/presets.ts";
import { type SupportInput, supportOf } from "../src/spec/confidence.ts";

const FRAME_MS = 1000 / 60;
const NONE = { under: 0, over: 0 };

describe("plausible curves", () => {
	it("keeps control points in range: y in [0, 1] without overshoot, [-1, 2] with it", () => {
		expect(sanitizeBezier([0.5777, -2, 1.2, -2], false)).toEqual([
			0.5777, 0, 1, 0,
		]);
		expect(sanitizeBezier([0.3, 3, 0.6, -2], true)).toEqual([0.3, 2, 0.6, -1]);
	});

	it("names no preset a step, and rejects near-vertical jumps", () => {
		for (const p of PRESETS)
			expect(isStepLike((u) => bezierY(p.p, u))).toBe(false);
		expect(isStepLike((u) => bezierY([0, 1, 0, 1], u))).toBe(true);
	});

	it("allows overshoot only as far as the readings show it", () => {
		const back = [0.34, 1.56, 0.64, 1] as const;
		expect(curveRange((u) => bezierY(back, u))[1]).toBeGreaterThan(1.05);
		expect(plausibleBezier(back, NONE, 0.02)).toBe(false);
		expect(plausibleBezier(back, { under: 0, over: 0.1 }, 0.02)).toBe(true);
	});

	it("keeps a fitted start value inside its range", () => {
		const ease = [0.22, 1, 0.36, 1] as const;
		const obs = Array.from({ length: 30 }, (_, k) => {
			const t = k * FRAME_MS;
			const v = bezierY(ease, (t - 100) / 300);
			return { t, lo: v, hi: v };
		});
		const fit = fitJoint(
			[{ obs, to: 1, weight: 1, group: 0, range: [0.5, 1] }],
			[{ startMs: 100, endMs: 400, frameMs: FRAME_MS }],
		);
		expect(fit.wanted[0]).toBeLessThan(0.5);
		expect(fit.froms[0]).toBe(0.5);
	});
});

describe("confidence from evidence", () => {
	const plain = (n: number, q?: number) =>
		Array.from({ length: n }, (_, k) => ({
			t: k * FRAME_MS,
			lo: k,
			hi: k,
			...(q === undefined ? {} : { q }),
		}));
	const base = {
		startMs: 0,
		durationMs: 300,
		rmse: 0.002,
		observed: 1,
		noise: 0,
	};

	it("is high with many exact samples, all of the change seen and a tight fit", () => {
		expect(supportOf({ ...base, obs: plain(19) }).confidence).toBe("high");
	});

	it("is low with too few samples, a loose fit, little of the change seen or poor matches", () => {
		const low = (o: Partial<SupportInput>) =>
			supportOf({ ...base, obs: plain(19), ...o });
		expect(low({ obs: plain(2) }).support.weak).toEqual([
			"2 reliable samples in the motion",
		]);
		expect(low({ rmse: 0.05 }).confidence).toBe("low");
		expect(low({ observed: 0.3 }).confidence).toBe("low");
		expect(low({ obs: plain(19, 0.3) }).support.weak).toEqual([
			"0 reliable samples in the motion",
			"mean match quality 0.3",
		]);
		expect(low({ weak: ["start value capped"] }).confidence).toBe("low");
	});

	it("allows video reading noise in the fit before lowering confidence", () => {
		const s = supportOf({ ...base, obs: plain(19), rmse: 0.04, noise: 0.03 });
		expect(s.confidence).toBe("medium");
	});
});
