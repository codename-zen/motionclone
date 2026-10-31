import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Answer } from "../fixtures/answer-schema.ts";
import { captureMotion, FIRST_FRAME_MS } from "../src/capture/index.ts";
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
import { readTrack } from "../src/measure/elements.ts";
import { extractSeries } from "../src/measure/series.ts";
import { motionWindow } from "../src/measure/window.ts";
import { type StaticServer, serveRepo } from "./serve.ts";
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

describe("real captures", () => {
	let server: StaticServer;
	let root: string;
	beforeAll(async () => {
		server = await serveRepo();
		root = await mkdtemp(join(tmpdir(), "motionclone-fit-"));
	});
	afterAll(async () => {
		await server?.close();
		if (root) await rm(root, { recursive: true, force: true });
	});

	const answerOf = async (name: string) =>
		Answer.parse(
			JSON.parse(await readFile(`fixtures/${name}/answer.json`, "utf8")),
		);

	async function seriesOf(
		name: string,
		track: string,
		durationMs: number,
		extra: Record<string, unknown> = {},
	) {
		const summary = await captureMotion({
			url: `${server.url}/fixtures/${name}/index.html`,
			outDir: join(root, name),
			durationMs,
			fps: 60,
			track: [track],
			...extra,
		});
		return (await readTrack(summary.outDir)).frames;
	}

	function fitRow(
		frames: Awaited<ReturnType<typeof seriesOf>>,
		sel: string,
		index: number,
		prop: "translateY" | "translateX",
	) {
		const series = extractSeries(frames, sel, index, prop);
		const w = motionWindow(series);
		if (!w) throw new Error("no window");
		const { samples, hint } = normalise(series, w);
		return { series, w, fit: fitBezier(samples, hint) };
	}

	it("css-fade-up-stagger recovers easing, duration and stagger", async () => {
		const answer = await answerOf("css-fade-up-stagger");
		const frames = await seriesOf("css-fade-up-stagger", ".card", 1300);
		for (const index of [0, 1, 2, 3]) {
			const row = answer.rows.find(
				(r) => r.index === index && r.property === "translateY",
			);
			if (row?.easing.type !== "cubic-bezier") throw new Error("answer row");
			const { fit } = fitRow(frames, ".card", index, "translateY");
			const dev = maxDeviation(
				bezierCurve(fit.p, fit.delayMs, fit.durationMs),
				bezierCurve(row.easing.p, row.startMs, row.durationMs),
				row.startMs - 60,
				row.startMs + row.durationMs + 300,
			);
			console.log(
				`fade-up[${index}]: dev=${dev.toFixed(4)} start=${fit.delayMs.toFixed(1)} (want ${row.startMs}) dur=${fit.durationMs.toFixed(1)} rmse=${fit.rmse.toExponential(2)} p=${fit.p.map((v) => v.toFixed(3))}`,
			);
			expect(dev).toBeLessThan(0.02);
			expect(Math.abs(fit.durationMs - row.durationMs)).toBeLessThanOrEqual(
				FRAME_MS,
			);
			expect(Math.abs(fit.delayMs - row.startMs)).toBeLessThanOrEqual(FRAME_MS);
		}
	});

	it("motion-spring translateX classifies as a spring with the keyed damping ratio", async () => {
		const answer = await answerOf("motion-spring");
		const row = answer.rows[0];
		if (row?.easing.type !== "spring") throw new Error("answer row");
		const zeta = dampingRatio(row.easing);
		const frames = await seriesOf("motion-spring", ".box", 1000, {
			trigger: { type: "click", target: ".go" },
		});
		const series = extractSeries(frames, ".box", 0, "translateX");
		const w = motionWindow(series);
		if (!w) throw new Error("no window");
		const c = classifyMotion(series, w);
		console.log(
			`motion-spring: best=${c.best.kind} overshoot=${c.overshoot.toFixed(4)} ${c.candidates.map((k) => `${k.kind}:${k.rmse.toFixed(4)}`).join(" ")}`,
		);
		if (c.best.kind !== "spring") throw new Error("not a spring");
		console.log(
			`motion-spring: zeta ${c.best.zeta.toFixed(4)} vs ${zeta.toFixed(4)}, start ${c.best.delayMs.toFixed(1)}`,
		);
		expect(Math.abs(c.best.zeta / zeta - 1)).toBeLessThan(0.1);
	});

	it("gsap-timeline item 0 fits power3.out", async () => {
		const answer = await answerOf("gsap-timeline");
		const row = answer.rows.find(
			(r) => r.index === 0 && r.property === "translateY",
		);
		if (row?.easing.type !== "cubic-bezier") throw new Error("answer row");
		const frames = await seriesOf("gsap-timeline", ".item", 1200);
		const { fit } = fitRow(frames, ".item", 0, "translateY");
		// JS timelines count from script time, which is FIRST_FRAME_MS before t=0 (see ADR 0001).
		const keyStart = row.startMs - FIRST_FRAME_MS;
		const vsKey = maxDeviation(
			bezierCurve(fit.p, fit.delayMs, fit.durationMs),
			bezierCurve(row.easing.p, keyStart, row.durationMs),
			keyStart - 60,
			keyStart + row.durationMs + 300,
		);
		console.log(
			`gsap[0]: start=${fit.delayMs.toFixed(1)} dur=${fit.durationMs.toFixed(1)} rmse=${fit.rmse.toExponential(2)} preset=${fit.preset.name} (${fit.preset.rmse.toExponential(2)}) vs key curve dev=${vsKey.toFixed(4)}`,
		);
		expect(vsKey).toBeLessThan(0.02);
		expect(Math.abs(fit.delayMs - keyStart)).toBeLessThanOrEqual(FRAME_MS);
		expect(fit.preset.aliases).toContain("power3.out");
		expect(fit.preset.rmse).toBeLessThan(0.005);
		expect(fit.rmse).toBeLessThan(0.003);
	});
});
