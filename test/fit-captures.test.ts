import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Answer } from "../fixtures/answer-schema.ts";
import { captureMotion, FIRST_FRAME_MS } from "../src/capture/index.ts";
import { fitBezier } from "../src/fit/bezier.ts";
import { classifyMotion, normalise } from "../src/fit/classify.ts";
import { dampingRatio } from "../src/fit/spring.ts";
import { readTrack } from "../src/measure/elements.ts";
import { extractSeries } from "../src/measure/series.ts";
import { motionWindow } from "../src/measure/window.ts";
import { type StaticServer, serveRepo } from "./serve.ts";
import { bezierCurve, FRAME_MS, maxDeviation } from "./synth.ts";

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
