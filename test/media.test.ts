import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { designSheet } from "../src/media/design-sheet.ts";
import { sideBySide } from "../src/media/side-by-side.ts";
import { runFfmpegOrThrow, scanFrames } from "../src/video/ffmpeg.ts";
import { probeVideo } from "../src/video/probe.ts";

let root: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-media-"));
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

type Gray = (frame: number) => number;

/** A capture directory of flat grey frames, enough for compose tests. */
async function fakeCapture(
	name: string,
	width: number,
	height: number,
	frames: number,
	gray: Gray,
	verdict?: { pass: boolean; passed: number; failed: number },
): Promise<string> {
	const dir = join(root, name);
	await mkdir(join(dir, "frames"), { recursive: true });
	await writeFile(
		join(dir, "capture.json"),
		JSON.stringify({ frames, frameMs: 100, triggerAtMs: 0 }),
	);
	for (let k = 0; k < frames; k++) {
		const png = new PNG({ width, height });
		const v = gray(k);
		for (let i = 0; i < png.data.length; i += 4)
			png.data.set([v, v, v, 255], i);
		await writeFile(
			join(dir, "frames", `${String(k).padStart(4, "0")}.png`),
			PNG.sync.write(png),
		);
	}
	if (verdict)
		await writeFile(
			join(dir, "verdict.json"),
			JSON.stringify({
				pass: verdict.pass,
				summary: { passed: verdict.passed, failed: verdict.failed },
			}),
		);
	return dir;
}

async function firstFrame(file: string): Promise<PNG> {
	const out = join(root, `first-${Math.random().toString(36).slice(2)}.png`);
	await runFfmpegOrThrow([
		"-v",
		"error",
		"-y",
		"-i",
		file,
		"-frames:v",
		"1",
		out,
	]);
	return PNG.sync.read(await readFile(out));
}

function count(
	img: PNG,
	x0: number,
	x1: number,
	y1: number,
	test: (r: number, g: number, b: number) => boolean,
): number {
	let n = 0;
	for (let y = 0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const p = (y * img.width + x) * 4;
			if (
				test(
					img.data[p] as number,
					img.data[p + 1] as number,
					img.data[p + 2] as number,
				)
			)
				n++;
		}
	return n;
}

describe("sideBySide", () => {
	it("writes a labelled gif with verdict lines", async () => {
		const ref = await fakeCapture("ref", 200, 100, 10, (k) => 40 + k * 10);
		const bad = await fakeCapture("bad", 100, 100, 10, (k) => 40 + k * 10, {
			pass: false,
			passed: 1,
			failed: 3,
		});
		const good = await fakeCapture("good", 300, 150, 10, (k) => 40 + k * 10, {
			pass: true,
			passed: 4,
			failed: 0,
		});
		const out = join(root, "out.gif");
		const r = await sideBySide({
			dirs: [ref, bad, good],
			out,
			fps: 10,
			width: 600,
			labels: ["Ref", "Bad", "Good"],
		});
		expect(r.frames).toBe(10);
		expect(r.warnings).toEqual([]);
		const probe = await probeVideo(out);
		expect([probe.width, probe.height]).toEqual([r.width, r.height]);
		expect(r.width).toBeLessThanOrEqual(600);
		expect((await scanFrames(out)).frames).toHaveLength(10);

		const img = await firstFrame(out);
		const third = Math.floor(img.width / 3);
		const header = 30;
		const light = (r: number, g: number, b: number) =>
			r > 180 && g > 180 && b > 180;
		const red = (r: number, g: number, b: number) =>
			r > 200 && g < 150 && b < 150;
		const green = (r: number, g: number, b: number) =>
			g > 180 && r < 150 && b < 170;
		expect(count(img, 0, third, header, light)).toBeGreaterThan(5);
		expect(count(img, 0, third, header, red)).toBe(0);
		expect(count(img, third, 2 * third, header, red)).toBeGreaterThan(5);
		expect(count(img, 2 * third, img.width, header, green)).toBeGreaterThan(5);
	}, 60_000);

	it("writes an mp4 that probes as h264 with even size", async () => {
		const ref = await fakeCapture("mref", 200, 100, 10, () => 90);
		const clone = await fakeCapture("mclone", 200, 100, 10, () => 120);
		const out = join(root, "out.mp4");
		const r = await sideBySide({
			dirs: [ref, clone],
			out,
			fps: 10,
			crop: ["0,0,100,100"],
		});
		expect((await stat(out)).size).toBeGreaterThan(0);
		const probe = await probeVideo(out);
		expect(probe.codec).toBe("h264");
		expect([probe.width, probe.height]).toEqual([r.width, r.height]);
		expect(r.width % 2).toBe(0);
		expect(r.height % 2).toBe(0);
		expect(probe.durationS).toBeGreaterThan(0.8);
	}, 60_000);

	it("rejects a bad output name and a missing capture", async () => {
		const ref = await fakeCapture("eref", 20, 20, 3, () => 0);
		await expect(
			sideBySide({ dirs: [ref, ref], out: join(root, "x.avi") }),
		).rejects.toThrow(".gif or .mp4");
		await expect(
			sideBySide({ dirs: [ref, join(root, "none")], out: join(root, "x.gif") }),
		).rejects.toThrow("capture.json");
	});
});

describe("designSheet", () => {
	it("shows reference, clone and difference for first, plateau and last frames", async () => {
		const shape: Gray = (k) => (k < 3 ? 20 : k < 6 ? 20 + (k - 2) * 40 : 200);
		const ref = await fakeCapture("sref", 200, 100, 10, shape);
		const clone = await fakeCapture("sclone", 200, 100, 10, (k) =>
			k === 9 ? 90 : shape(k),
		);
		const r = await designSheet(ref, clone, join(root, "sheet"));
		expect(r.moments.map((m) => m.refFrame)).toEqual([0, 6, 9]);
		expect(r.moments[0]?.label).toBe("first frame 0 ms");
		expect(r.moments[2]?.label).toBe("last frame 900 ms");
		const sheet = PNG.sync.read(await readFile(r.png));
		const tileH = 100;
		const rowH = 20 + tileH + 8;
		const diffX = 8 + 2 * 208;
		const strongDiff = (row: number) =>
			count(
				sheet,
				diffX,
				diffX + 200,
				8 + 20 + row * rowH + 20 + tileH,
				(r, g, b) => r > 200 && g < 80 && b < 80,
			) -
			count(
				sheet,
				diffX,
				diffX + 200,
				8 + 20 + row * rowH + 20,
				(r, g, b) => r > 200 && g < 80 && b < 80,
			);
		expect(strongDiff(0)).toBe(0);
		expect(strongDiff(1)).toBe(0);
		expect(strongDiff(2)).toBeGreaterThan(1000);
	});
});
