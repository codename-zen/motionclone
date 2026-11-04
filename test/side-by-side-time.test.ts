import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sideBySide } from "../src/media/side-by-side.ts";
import { runFfmpegOrThrow } from "../src/video/ffmpeg.ts";

const FRAME_MS = 100;
const FRAMES = 12;
const SIZE = 100;
const GAP = 12;

let root: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-sbs-time-"));
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Flat grey frames with a track.json that stamps frame k at k * FRAME_MS. */
async function capture(
	name: string,
	triggerAtMs: number,
	gray: (k: number) => number,
): Promise<string> {
	const dir = join(root, name);
	await mkdir(join(dir, "frames"), { recursive: true });
	await writeFile(
		join(dir, "capture.json"),
		JSON.stringify({ frames: FRAMES, frameMs: FRAME_MS, triggerAtMs }),
	);
	await writeFile(
		join(dir, "track.json"),
		JSON.stringify({
			selectors: [],
			frameMs: FRAME_MS,
			frames: Array.from({ length: FRAMES }, (_, k) => ({
				frame: k,
				t: k * FRAME_MS,
				scrollY: 0,
				elements: {},
			})),
		}),
	);
	for (let k = 0; k < FRAMES; k++) {
		const png = new PNG({ width: SIZE, height: SIZE });
		for (let i = 0; i < png.data.length; i += 4)
			png.data.set([gray(k), gray(k), gray(k), 255], i);
		await writeFile(
			join(dir, "frames", `${String(k).padStart(4, "0")}.png`),
			PNG.sync.write(png),
		);
	}
	return dir;
}

describe("sideBySide time alignment", () => {
	it("keeps both panes at the same timestamp when the reference repeats frames and the clone's trigger sits off the frame grid", async () => {
		const ref = await capture("ref", 0, (k) => 40 + 10 * (k - (k % 2)));
		const clone = await capture("clone", 40, (k) => 40 + 10 * k);
		const out = join(root, "aligned.mp4");
		const r = await sideBySide({ dirs: [ref, clone], out, fps: 30 });
		await runFfmpegOrThrow([
			"-v",
			"error",
			"-i",
			out,
			"-fps_mode",
			"passthrough",
			join(root, "f%d.png"),
		]);
		expect(r.frames).toBeGreaterThan(30);
		for (let n = 0; n < r.frames; n++) {
			const shot = PNG.sync.read(await readFile(join(root, `f${n + 1}.png`)));
			const y = shot.height - GAP - SIZE / 2;
			const at = (x: number) => shot.data[(y * shot.width + x) * 4] as number;
			const idx = Math.round((n * (1000 / 30)) / FRAME_MS);
			expect(at(GAP + SIZE / 2)).toBeCloseTo(40 + 10 * (idx - (idx % 2)), -1);
			expect(at(2 * GAP + SIZE + SIZE / 2)).toBeCloseTo(40 + 10 * idx, -1);
		}
	}, 60_000);
});
