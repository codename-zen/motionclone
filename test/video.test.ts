import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnswerRow } from "../fixtures/answer-schema.ts";
import { readTrack } from "../src/measure/elements.ts";
import { draftSpec } from "../src/spec/draft.ts";
import { verify } from "../src/verify/index.ts";
import { runFfmpegOrThrow } from "../src/video/ffmpeg.ts";
import { captureVideo, extractFrames, probeVideo } from "../src/video/index.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import { maxDeviation } from "./synth.ts";
import {
	answerEasing,
	answerOf,
	boxAt,
	frameFile,
	mismatch,
	padded,
	readPng,
	rowOf,
	timed,
} from "./video-helpers.ts";

const FPS = 60;
const FRAME_MS = 1000 / FPS;
const PAD = 6;

describe("video input", () => {
	let session: CaptureSession;
	let tmp: string;
	let fade: string;
	let spring: string;
	const media = (name: string) => join(tmp, name);

	const encode = (frames: string, out: string, args: string[]) =>
		runFfmpegOrThrow([
			"-v",
			"error",
			"-framerate",
			String(FPS),
			"-i",
			join(frames, "frames", "%04d.png"),
			...args,
			"-y",
			out,
		]);

	beforeAll(async () => {
		// A space in the path exercises argument handling.
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-"));
		session = await openCaptureSession("video");
		fade = await session.capture("css-fade-up-stagger", "fade", {
			durationMs: 1500,
			fps: FPS,
			track: [".card"],
		});
		spring = await session.capture("motion-spring", "spring", {
			durationMs: 1200,
			fps: FPS,
			track: [".box"],
			trigger: { type: "click", target: ".go" },
		});
		const x264 = ["-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p"];
		await encode(fade, media("fade.mp4"), x264);
		await encode(fade, media("fade.mov"), ["-c:v", "png"]);
		await encode(fade, media("fade.gif"), [
			"-vf",
			"fps=30,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
		]);
		await encode(spring, media("spring.mp4"), x264);
	}, 180_000);

	afterAll(async () => {
		await session?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	it("probes size, rate and duration", async () => {
		const mp4 = await probeVideo(media("fade.mp4"));
		console.log("probe mp4", mp4);
		expect(mp4).toMatchObject({
			width: 1280,
			height: 800,
			fps: 60,
			codec: "h264",
			fpsFromFrames: false,
		});
		expect(mp4.durationS).toBeCloseTo(91 / 60, 2);
		const gif = await probeVideo(media("fade.gif"));
		console.log("probe gif", gif);
		expect(gif).toMatchObject({
			width: 640,
			height: 400,
			fps: 30,
			codec: "gif",
			fpsFromFrames: true,
		});
		expect(gif.durationS).toBeCloseTo(1.53, 1);
	});

	it("extracts the exact grid frames: lossless round trip and mp4 within 1 %", async () => {
		const mov = await extractFrames({
			input: media("fade.mov"),
			outDir: media("x-mov"),
			start: "250ms",
			fps: 30,
		});
		expect(mov.frames).toBe(Math.floor((1.5 - 0.25) * 30) + 1);
		expect(mov.sourceFrames.slice(0, 3)).toEqual([15, 17, 19]);
		for (const k of [0, 5, mov.frames - 1]) {
			const [a, b] = await Promise.all([
				readPng(frameFile(mov.outDir, k)),
				readPng(frameFile(fade, 15 + 2 * k)),
			]);
			expect(Buffer.compare(a.data, b.data), `frame ${k}`).toBe(0);
		}
		const mp4 = await extractFrames({
			input: media("fade.mp4"),
			outDir: media("x-mp4"),
		});
		expect(mp4.frames).toBe(91);
		expect(mp4.fps).toBe(60);
		const m = mismatch(
			await readPng(frameFile(mp4.outDir, 0)),
			await readPng(frameFile(fade, 0)),
		);
		const m40 = mismatch(
			await readPng(frameFile(mp4.outDir, 40)),
			await readPng(frameFile(fade, 40)),
		);
		console.log(
			`mp4 mismatch frame 0 ${(m * 100).toFixed(3)} %, frame 40 ${(m40 * 100).toFixed(3)} %`,
		);
		expect(m).toBeLessThan(0.01);
		expect(m40).toBeLessThan(0.01);
		const crop = await extractFrames({
			input: media("fade.mov"),
			outDir: media("x-crop"),
			end: 0.1,
			crop: { x: 40, y: 60, w: 600, h: 300 },
			width: 300,
		});
		expect(crop).toMatchObject({
			frames: 7,
			width: 300,
			height: 150,
			scale: 0.5,
		});
		const cap = JSON.parse(
			await readFile(join(crop.outDir, "capture.json"), "utf8"),
		);
		expect(cap).toMatchObject({
			source: "video",
			stack: ["video"],
			video: { start: 0, crop: { x: 40 } },
		});
	});

	/** Check a drafted video row (box y) against the fixture's translateY key. */
	async function checkFade(
		dir: string,
		frameMs: number,
		durationFrames: number,
		id = (i: number) => `card${i + 1}[0].y`,
	) {
		const spec = await draftSpec(dir, { write: false });
		const answer = await answerOf("css-fade-up-stagger");
		const starts: number[] = [];
		for (const key of answer.rows.filter((r) => r.property === "translateY")) {
			const row = rowOf(spec, id(key.index));
			const dev = maxDeviation(
				timed(row.easing, row.startMs, row.durationMs),
				timed(answerEasing(key), key.startMs, key.durationMs),
				key.startMs - 60,
				key.startMs + key.durationMs + 300,
			);
			const dist = Math.abs(row.to - row.from);
			console.log(
				`${row.id}: start ${row.startMs} vs ${key.startMs}, duration ${row.durationMs} vs ${key.durationMs}, curve dev ${dev.toFixed(4)}, distance ${dist.toFixed(2)} vs 32, easing ${JSON.stringify(row.easing.type === "cubic-bezier" ? row.easing.p : row.easing.type)}`,
			);
			starts.push(row.startMs);
			expect(Math.abs(row.startMs - key.startMs)).toBeLessThanOrEqual(frameMs);
			expect(Math.abs(row.durationMs - key.durationMs)).toBeLessThanOrEqual(
				durationFrames * frameMs,
			);
			expect(dev).toBeLessThan(0.05);
			expect(Math.abs(dist / 32 - 1)).toBeLessThanOrEqual(0.1);
		}
		return { spec, starts };
	}

	const cardRegions = async (scale = 1) => {
		const track = await readTrack(fade);
		return [0, 1, 2, 3].map((i) => ({
			name: `card${i + 1}`,
			...padded(boxAt(track.frames.at(-1), ".card", i), PAD, scale),
		}));
	};

	it("fade-up stagger mp4: starts, stagger, duration and easing from pixels", async () => {
		const summary = await captureVideo({
			input: media("fade.mp4"),
			outDir: media("v-fade"),
			regions: await cardRegions(),
		});
		console.log("regions", JSON.stringify(summary.regions), summary.warnings);
		const { spec, starts } = await checkFade(summary.outDir, FRAME_MS, 2);
		for (let i = 1; i < starts.length; i++) {
			const gap = (starts[i] as number) - (starts[i - 1] as number);
			console.log(`stagger ${i}: ${gap.toFixed(1)} ms`);
			expect(Math.abs(gap - 90)).toBeLessThanOrEqual(FRAME_MS);
		}
		const track = await readTrack(summary.outDir);
		for (const name of track.selectors) {
			const op = track.frames.map(
				(f) => f.elements[name]?.[0]?.opacity ?? Number.NaN,
			);
			const drops = op.slice(1).map((v, i) => (op[i] as number) - v);
			console.log(
				`${name} opacity first ${op[0]}, last ${op.at(-1)}, largest drop ${Math.max(...drops).toFixed(3)}`,
			);
			expect(op[0]).toBeLessThanOrEqual(0.05);
			expect(op.at(-1)).toBeGreaterThanOrEqual(0.95);
			// The contrast proxy jitters by up to 0.03 on crf 18 h264.
			expect(Math.max(...drops)).toBeLessThanOrEqual(0.05);
		}
		const verdict = await verify(spec, summary.outDir, summary.outDir, {
			outDir: false,
		});
		expect(verdict.setupErrors).toEqual([]);
		expect(verdict.pass).toBe(true);
	});

	it("motion-spring mp4: a spring with the keyed damping ratio and overshoot", async () => {
		const track = await readTrack(spring);
		const summary = await captureVideo({
			input: media("spring.mp4"),
			outDir: media("v-spring"),
			regions: [
				{ name: "box", ...padded(boxAt(track.frames[0], ".box", 0), PAD) },
			],
		});
		const spec = await draftSpec(summary.outDir, { write: false });
		const row = rowOf(spec, "box[0].x");
		const answer = await answerOf("motion-spring");
		const key = answer.rows[0] as AnswerRow;
		if (row.easing.type !== "spring" || key.easing.type !== "spring")
			throw new Error(`not a spring: ${JSON.stringify(row.easing)}`);
		const keyZeta =
			key.easing.damping /
			(2 * Math.sqrt(key.easing.stiffness * key.easing.mass));
		console.log(
			`spring: zeta ${row.easing.zeta} vs ${keyZeta.toFixed(3)}, overshoot ${row.overshoot}, distance ${(row.to - row.from).toFixed(1)}`,
		);
		expect(Math.abs(row.easing.zeta / keyZeta - 1)).toBeLessThanOrEqual(0.15);
		expect(row.overshoot).toBeGreaterThan(0.05);
	});

	it("fade-up stagger gif at 30 fps, half size: starts within a frame", async () => {
		const summary = await captureVideo({
			input: media("fade.gif"),
			outDir: media("v-gif"),
			cssScale: 0.5,
			regions: await cardRegions(0.5),
		});
		expect(summary.fps).toBe(30);
		const spec = await draftSpec(summary.outDir, { write: false });
		const answer = await answerOf("css-fade-up-stagger");
		for (const key of answer.rows.filter((r) => r.property === "translateY")) {
			const row = rowOf(spec, `card${key.index + 1}[0].y`);
			console.log(
				`gif ${row.id}: start ${row.startMs} vs ${key.startMs}, duration ${row.durationMs}, distance ${(row.from - row.to).toFixed(2)}`,
			);
			expect(Math.abs(row.startMs - key.startMs)).toBeLessThanOrEqual(
				1000 / 30,
			);
		}
	});

	it("automatic regions find the four cards", async () => {
		const summary = await captureVideo({
			input: media("fade.mp4"),
			outDir: media("v-auto"),
		});
		console.log("auto", JSON.stringify(summary.regions), summary.warnings);
		expect(summary.regions).toHaveLength(4);
		const track = await readTrack(fade);
		const last = track.frames.at(-1);
		summary.regions.forEach((r, i) => {
			const card = boxAt(last, ".card", i);
			expect(Math.abs(r.box.x - card.x)).toBeLessThanOrEqual(2);
			expect(Math.abs(r.box.w - card.w)).toBeLessThanOrEqual(4);
		});
		await checkFade(summary.outDir, FRAME_MS, 2, (i) => `blob[${i}].y`);
	});
});
