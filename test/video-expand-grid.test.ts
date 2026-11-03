import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrackedElement } from "../src/capture/types.ts";
import { fitBezier } from "../src/fit/bezier.ts";
import { readTrack, type Track } from "../src/measure/elements.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { captureVideo } from "../src/video/index.ts";
import type { RegionSample, RegionTrack } from "../src/video/samples.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import { encodeFrames, padded, rowOf, sweep, X264 } from "./video-helpers.ts";

const FPS = 57;
const FRAME_MS = 1000 / FPS;
// Like a hand-drawn region on a phone recording: a few pixels around the start and end boxes, neighbour tiles inside.
const PAD = 6;
const FROM = 0.624;
const SCALE_START_MS = 640;
const SCALE_MS = 310;

const domScale = (e: TrackedElement) =>
	e.scale && e.scale !== "none" ? Number(e.scale) : 1;

describe("video input: a card in a colourful grid that expands while the tiles dim", () => {
	let session: CaptureSession;
	let tmp: string;
	let dom: Track;
	let card: RegionTrack;
	let spec: SpecFile;

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-expand-grid-"));
		session = await openCaptureSession("video-expand-grid");
		const domDir = await session.capture("expand-in-grid", "dom", {
			durationMs: 1400,
			fps: FPS,
			viewport: { width: 816, height: 1080 },
			track: [".card", ".dim"],
		});
		dom = await readTrack(domDir);
		await encodeFrames(domDir, join(tmp, "grid.mp4"), FPS, X264);
		const started = performance.now();
		const summary = await captureVideo({
			input: join(tmp, "grid.mp4"),
			outDir: join(tmp, "video"),
			regions: [{ name: "card", ...padded(sweep(dom, ".card"), PAD) }],
		});
		card = JSON.parse(
			await readFile(join(summary.outDir, "regions.json"), "utf8"),
		).regions[0];
		spec = await draftSpec(summary.outDir, { write: false });
		console.log(
			`captureVideo ${summary.frames} frames: ${((performance.now() - started) / 1000).toFixed(1)} s`,
			JSON.stringify(summary.regions),
			summary.warnings,
		);
	}, 300_000);

	afterAll(async () => {
		await session?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	const sample = (k: number) => card.samples[k] as RegionSample;
	const domEl = (k: number) =>
		dom.frames[k]?.elements[".card"]?.[0] as TrackedElement;
	const refFrame = () => (card.ref === "first" ? 0 : card.samples.length - 1);
	const pageScale = (k: number) =>
		domScale(domEl(k)) / domScale(domEl(refFrame()));
	const frames = () => card.samples.map((_, k) => k);

	it("finds the card on almost every frame, the static grid phase included", () => {
		const found = frames().filter((k) => sample(k).found);
		const methods = new Map<string, number>();
		for (const k of frames())
			methods.set(sample(k).method, (methods.get(sample(k).method) ?? 0) + 1);
		console.log(
			`found ${found.length}/${frames().length}; ref ${card.ref}; methods ${JSON.stringify([...methods])}`,
		);
		expect(found.length / frames().length).toBeGreaterThanOrEqual(0.95);
	});

	it("measures scale like the page on every found frame", () => {
		let worst = 0;
		for (const k of frames()) {
			if (!sample(k).found) continue;
			const d = Math.abs(sample(k).scale - pageScale(k));
			worst = Math.max(worst, d);
			expect(d, `frame ${k} scale`).toBeLessThanOrEqual(0.03);
		}
		console.log(`worst scale error ${worst.toFixed(4)}`);
	});

	it("fits the scale change with its start and duration", () => {
		const series = frames().map((k) => ({
			t: dom.frames[k]?.t as number,
			s: sample(k).scale,
		}));
		const from = series[0]?.s as number;
		const rest = series.filter((p) => p.t >= 1000);
		const to = rest.reduce((a, p) => a + p.s, 0) / rest.length;
		const samples = series.map(
			(p) => [p.t, (p.s - from) / (to - from)] as const,
		);
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

	it("drafts a scale row that starts at the grid size", () => {
		const row = rowOf(spec, "card[0].scale");
		console.log(
			`scale row: ${row.from} -> ${row.to}, start ${row.startMs} ms, duration ${row.durationMs} ms`,
		);
		expect(Math.abs((row.from as number) - FROM)).toBeLessThanOrEqual(0.03);
	});
});
