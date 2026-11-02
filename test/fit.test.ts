import { describe, expect, it } from "vitest";
import { fitBezier } from "../src/fit/bezier.ts";
import { classifyMotion, normalise } from "../src/fit/classify.ts";
import type { BezierParams } from "../src/fit/presets.ts";
import {
	dampingRatio,
	fitSpring,
	settleMs,
	springResponse,
	toCssLinear,
} from "../src/fit/spring.ts";
import { fitSteps } from "../src/fit/steps.ts";
import { motionWindow } from "../src/measure/window.ts";
import {
	bezierCurve,
	FRAME_MS,
	maxDeviation,
	sample,
	springCurve,
	stepsCurve,
} from "./synth.ts";

const CURVES: [string, BezierParams][] = [
	["ease-out", [0, 0, 0.58, 1]],
	["easeOutExpo", [0.16, 1, 0.3, 1]],
	["easeInOutCubic", [0.65, 0, 0.35, 1]],
	["custom", [0.3, 0.1, 0.2, 1]],
];

function fitSynthetic(
	p: BezierParams,
	delay: number,
	dur: number,
	noise: number,
) {
	const series = sample(bezierCurve(p, delay, dur), { noise });
	const w = motionWindow(series);
	if (!w) throw new Error("no window");
	const { samples, hint } = normalise(series, w);
	const fit = fitBezier(samples, hint);
	const dev = maxDeviation(
		bezierCurve(fit.p, fit.delayMs, fit.durationMs),
		bezierCurve(p, delay, dur),
		delay - 60,
		delay + dur + 300,
	);
	return { fit, dev };
}

describe("bezier fit on synthetic series", () => {
	for (const [name, p] of CURVES)
		for (const noise of [0, 0.001]) {
			it(`${name} noise ${noise}`, () => {
				const { fit, dev } = fitSynthetic(p, 200, 700, noise);
				console.log(
					`bezier ${name} noise=${noise}: dev=${dev.toFixed(4)} dur=${fit.durationMs.toFixed(1)} delay=${fit.delayMs.toFixed(1)} p=${fit.p.map((v) => v.toFixed(3))} preset=${fit.preset.name}`,
				);
				expect(dev).toBeLessThan(0.01);
				// easeOutExpo's last 15% moves under 1e-4, below any noise: the duration is unidentifiable there.
				if (noise === 0 || name !== "easeOutExpo")
					expect(Math.abs(fit.durationMs - 700)).toBeLessThanOrEqual(FRAME_MS);
				expect(Math.abs(fit.delayMs - 200)).toBeLessThanOrEqual(FRAME_MS);
				if (name === "custom")
					p.forEach((v, i) => {
						expect(Math.abs((fit.p[i] as number) - v)).toBeLessThan(0.03);
					});
			});
		}

	it("names the nearest preset", () => {
		const { fit } = fitSynthetic([0.16, 1, 0.3, 1], 200, 700, 0);
		expect(fit.preset.name).toBe("easeOutExpo");
		expect(fit.preset.rmse).toBeLessThan(0.01);
	});
});

const SPRINGS = [
	{ stiffness: 300, damping: 20, mass: 1 },
	{ stiffness: 170, damping: 26, mass: 1 },
	{ stiffness: 100, damping: 10, mass: 1 },
];

describe("spring fit on synthetic series", () => {
	for (const s of SPRINGS) {
		it(`k=${s.stiffness} c=${s.damping}`, () => {
			const series = sample(springCurve(s, 100), {
				noise: 0.001,
				lengthMs: 3000,
			});
			const w = motionWindow(series);
			if (!w) throw new Error("no window");
			const { samples, hint } = normalise(series, w);
			const fit = fitSpring(samples, hint);
			const zeta = dampingRatio(s);
			console.log(
				`spring k=${s.stiffness} c=${s.damping}: zeta ${fit.zeta.toFixed(4)} vs ${zeta.toFixed(4)}, settle ${fit.settleMs} vs ${settleMs(s)}, rmse ${fit.rmse.toFixed(5)}`,
			);
			expect(Math.abs(fit.zeta / zeta - 1)).toBeLessThan(0.1);
			expect(Math.abs(fit.settleMs / settleMs(s) - 1)).toBeLessThan(0.1);
			// Near-critical springs match a bezier within the tolerance, where the simpler model wins.
			if (zeta < 0.9)
				expect(classifyMotion(series, w).best.kind).toBe("spring");
		});

		it(`k=${s.stiffness} c=${s.damping} exports linear()`, () => {
			const { css, durationMs, stops } = toCssLinear(s);
			expect(css.startsWith("linear(")).toBe(true);
			const stopValues = css.slice(7, -1).split(",").map(Number);
			expect(stopValues.length).toBe(stops);
			expect(stopValues.length).toBeGreaterThanOrEqual(10);
			let worst = 0;
			for (let t = 0; t <= durationMs; t += 1) {
				const x = (t / durationMs) * (stopValues.length - 1);
				const i = Math.min(Math.floor(x), stopValues.length - 2);
				const a = stopValues[i] as number;
				const b = stopValues[i + 1] as number;
				worst = Math.max(
					worst,
					Math.abs(a + (b - a) * (x - i) - springResponse(s, t / 1000)),
				);
			}
			console.log(
				`linear() k=${s.stiffness}: ${stops} stops, ${durationMs} ms, max err ${worst.toFixed(4)}`,
			);
			expect(worst).toBeLessThan(0.02);
		});
	}
});

describe("steps", () => {
	it("recovers steps(8, end)", () => {
		const series = sample(stepsCurve(8, "end", 100, 800), { lengthMs: 1200 });
		const w = motionWindow(series);
		if (!w) throw new Error("no window");
		const { samples, hint } = normalise(series, w);
		const fit = fitSteps(samples, hint);
		expect(fit).toMatchObject({ count: 8, position: "end" });
		expect(Math.abs((fit?.durationMs ?? 0) - 800)).toBeLessThanOrEqual(
			FRAME_MS,
		);
		expect(classifyMotion(series, w).best.kind).toBe("steps");
	});

	// start and end staircases are the same curve shifted by one step, so only the count and the curve are checkable.
	it("recovers the staircase of steps(5, start)", () => {
		const series = sample(stepsCurve(5, "start", 100, 600), { lengthMs: 1000 });
		const w = motionWindow(series);
		if (!w) throw new Error("no window");
		const { samples, hint } = normalise(series, w);
		const fit = fitSteps(samples, hint);
		if (!fit) throw new Error("no fit");
		expect(fit.count).toBe(5);
		expect(fit.rmse).toBeLessThan(0.01);
	});
});

describe("classification", () => {
	it("a linear series is linear", () => {
		const series = sample((t) => Math.min(1, Math.max(0, (t - 100) / 500)));
		const w = motionWindow(series);
		if (!w) throw new Error("no window");
		expect(classifyMotion(series, w).best.kind).toBe("linear");
	});

	it("easeOutBack is not a plain bezier or spring pick over its preset", () => {
		const series = sample(bezierCurve([0.34, 1.56, 0.64, 1], 100, 600));
		const w = motionWindow(series);
		if (!w) throw new Error("no window");
		const c = classifyMotion(series, w);
		expect(c.overshoot).toBeGreaterThan(0.02);
		expect(c.best.overshoots).toBe(true);
	});

	it("a there-and-back move that returns exactly to its start has a finite fit", () => {
		const series = sample((t) => (t >= 300 && t < 500 ? 0.01 : 0));
		const w = motionWindow(series);
		if (!w) throw new Error("no window");
		expect(w.change).toBe(0);
		const c = classifyMotion(series, w);
		expect(Number.isFinite(c.best.rmse)).toBe(true);
	});
});
