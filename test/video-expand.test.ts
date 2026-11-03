import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrackedElement } from "../src/capture/types.ts";
import { fitBezier } from "../src/fit/bezier.ts";
import { readTrack, type Track } from "../src/measure/elements.ts";
import { captureVideo } from "../src/video/index.ts";
import type { RegionSample, RegionTrack } from "../src/video/samples.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import {
	type Box,
	boxAt,
	encodeFrames,
	padded,
	X264,
} from "./video-helpers.ts";

const FPS = 57;
const FRAME_MS = 1000 / FPS;
const PAD = 12;
const SCALE_START_MS = 640;
const SCALE_MS = 310;

const union = (a: Box, b: Box): Box => {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		w: Math.max(a.x + a.w, b.x + b.w) - x,
		h: Math.max(a.y + a.h, b.y + b.h) - y,
	};
};

const domScale = (e: TrackedElement) =>
	e.scale && e.scale !== "none" ? Number(e.scale) : 1;

describe("video input: a card that expands while the backdrop dims", () => {
	let session: CaptureSession;
	let tmp: string;
	let dom: Track;
	let video: Track;
	let card: RegionTrack;
	let seconds: number;

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-expand-"));
		session = await openCaptureSession("video-expand");
		const domDir = await session.capture("expand-dim-reveal", "dom", {
			durationMs: 2000,
			fps: FPS,
			viewport: { width: 816, height: 1080 },
			track: [".card", ".dim", ".cover"],
		});
		dom = await readTrack(domDir);
		await encodeFrames(domDir, join(tmp, "expand.mp4"), FPS, X264);
		const region = padded(
			union(
				boxAt(dom.frames[0], ".card", 0),
				boxAt(dom.frames.at(-1), ".card", 0),
			),
			PAD,
		);
		const started = performance.now();
		const summary = await captureVideo({
			input: join(tmp, "expand.mp4"),
			outDir: join(tmp, "video"),
			regions: [{ name: "card", ...region }],
		});
		seconds = (performance.now() - started) / 1000;
		video = await readTrack(summary.outDir);
		card = JSON.parse(
			await readFile(join(summary.outDir, "regions.json"), "utf8"),
		).regions[0];
		console.log(
			`captureVideo ${summary.frames} frames: ${seconds.toFixed(1)} s`,
			JSON.stringify(summary.regions),
			summary.warnings,
		);
	}, 240_000);

	afterAll(async () => {
		await session?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	const domEl = (k: number) =>
		dom.frames[k]?.elements[".card"]?.[0] as TrackedElement;
	const videoEl = (k: number) =>
		video.frames[k]?.elements.card?.[0] as TrackedElement;
	const sample = (k: number) => card.samples[k] as RegionSample;
	const refFrame = () => (card.ref === "first" ? 0 : dom.frames.length - 1);
	// Video scale is relative to the element at the reference end, so the page scale is too.
	const pageScale = (k: number) =>
		domScale(domEl(k)) / domScale(domEl(refFrame()));
	const frames = () => dom.frames.map((f) => f.frame);

	it("finds the card through the expansion", () => {
		const span = frames().filter((k) => {
			const t = dom.frames[k]?.t as number;
			return t >= 600 && t <= 1000;
		});
		const found = span.filter((k) => sample(k).found);
		const methods = new Map<string, number>();
		for (const k of frames())
			methods.set(sample(k).method, (methods.get(sample(k).method) ?? 0) + 1);
		console.log(
			`found ${found.length}/${span.length} frames in 600..1000 ms; methods ${JSON.stringify([...methods])}`,
		);
		expect(found.length / span.length).toBeGreaterThanOrEqual(0.95);
	});

	it("measures scale and centre like the page", () => {
		let worstScale = 0;
		let worstX = 0;
		for (const k of frames()) {
			if (!sample(k).found) continue;
			const ds = Math.abs(sample(k).scale - pageScale(k));
			const d = domEl(k);
			const v = videoEl(k);
			const dx = Math.abs(v.x + v.w / 2 - (d.x + d.w / 2));
			worstScale = Math.max(worstScale, ds);
			worstX = Math.max(worstX, dx);
			expect(ds, `frame ${k} scale`).toBeLessThanOrEqual(0.03);
			expect(dx, `frame ${k} centre x`).toBeLessThanOrEqual(4);
		}
		console.log(
			`worst scale error ${worstScale.toFixed(4)}, worst centre x error ${worstX.toFixed(2)} px`,
		);
	});

	it("fits the scale change with its start and duration", () => {
		const series = frames().map((k) => ({
			t: dom.frames[k]?.t as number,
			s: sample(k).scale,
		}));
		const from = series[0]?.s as number;
		const rest = series.filter((p) => p.t >= 1000 && p.t <= 1400);
		const to = rest.reduce((a, p) => a + p.s, 0) / rest.length;
		const samples = series
			.filter((p) => p.t <= 1400)
			.map((p) => [p.t, (p.s - from) / (to - from)] as const);
		const moving = samples.filter(([, v]) => v > 0.02 && v < 0.98);
		const fit = fitBezier(samples, {
			startMs: (moving[0]?.[0] as number) - FRAME_MS,
			endMs: moving.at(-1)?.[0] as number,
			frameMs: FRAME_MS,
		});
		console.log(
			`scale fit: start ${fit.delayMs.toFixed(1)} ms, duration ${fit.durationMs.toFixed(1)} ms, p ${fit.p.map((v) => v.toFixed(2)).join(",")}, ${from.toFixed(3)} -> ${to.toFixed(3)}`,
		);
		expect(Math.abs(fit.delayMs - SCALE_START_MS)).toBeLessThanOrEqual(
			2 * FRAME_MS,
		);
		expect(Math.abs(fit.durationMs - SCALE_MS)).toBeLessThanOrEqual(40);
	});
});
