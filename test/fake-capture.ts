import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { TrackedElement, TrackFrame } from "../src/capture/types.ts";

export const FAKE_FRAME_MS = 1000 / 30;

export const element = (v: Partial<TrackedElement>): TrackedElement => ({
	index: 0,
	x: 20,
	y: 20,
	w: 20,
	h: 20,
	opacity: 1,
	transform: "none",
	filter: "none",
	clipPath: "none",
	color: "#000000",
	backgroundColor: "#ffffff",
	boxShadow: "none",
	...v,
});

/**
 * A capture directory of white 64 x 64 frames at 30 fps whose track.json holds, per frame k, the elements
 * `elements(k)` returns: one element per selector. `extra` adds fields to capture.json.
 */
export async function fakeTrackCapture(
	dir: string,
	frames: number,
	elements: (k: number) => Record<string, Partial<TrackedElement>>,
	extra: Record<string, unknown> = {},
): Promise<string> {
	await mkdir(join(dir, "frames"), { recursive: true });
	const png = new PNG({ width: 64, height: 64 });
	png.data.fill(255);
	const bytes = PNG.sync.write(png);
	const track: TrackFrame[] = [];
	for (let k = 0; k < frames; k++) {
		await writeFile(
			join(dir, "frames", `${String(k).padStart(4, "0")}.png`),
			bytes,
		);
		const els = Object.entries(elements(k)).map(
			([s, v]): [string, TrackedElement[]] => [s, [element(v)]],
		);
		track.push({
			frame: k,
			t: k * FAKE_FRAME_MS,
			scrollY: 0,
			elements: Object.fromEntries(els),
		});
	}
	const selectors = Object.keys(elements(0));
	const options = {
		url: "video.mp4",
		viewport: { width: 64, height: 64 },
		trigger: { type: "none" },
		fps: 30,
		durationMs: (frames - 1) * FAKE_FRAME_MS,
		seed: 1,
		track: selectors,
	};
	const json = (file: string, value: unknown) =>
		writeFile(join(dir, file), JSON.stringify(value));
	await json("capture.json", {
		options,
		triggerAtMs: 0,
		frames,
		frameMs: FAKE_FRAME_MS,
		clip: { x: 0, y: 0, width: 64, height: 64 },
		stack: [],
		warnings: [],
		...extra,
	});
	await json("track.json", {
		selectors,
		frameMs: FAKE_FRAME_MS,
		frames: track,
	});
	await json("animations.json", { animations: [] });
	return dir;
}
