import { readTrack } from "../measure/elements.ts";
import { readCaptureFile } from "../spec/capture-file.ts";
import { readPng } from "../verify/pixels.ts";
import { regionsAt, writeLook } from "./file.ts";
import { pixelLook } from "./pixels.ts";
import { restFramesOf } from "./rest.ts";
import { LOOK_VERSION, type LookFile, type LookState } from "./schema.ts";
import { pixelSummary } from "./summary.ts";

/** The look of a video capture from its rest frames: first, every plateau between changes, and last. */
export async function measureVideoLook(dir: string): Promise<LookFile> {
	const [cap, track] = await Promise.all([
		readCaptureFile(dir),
		readTrack(dir),
	]);
	const clip = cap.clip;
	const rest = await restFramesOf(dir, cap.frames, cap.frameMs);
	const states: LookState[] = [];
	for (const r of rest) {
		const f = track.frames[r.frame];
		states.push({
			...r,
			t: f?.t ?? 0,
			page: null,
			pixels: pixelLook(await readPng(dir, r.frame), clip, regionsAt(f)),
		});
	}
	const last = states.at(-1) as LookState;
	const screen = { x: clip.x, y: clip.y, w: clip.width, h: clip.height };
	return {
		version: LOOK_VERSION,
		source: "video",
		screen: { width: clip.width, height: clip.height },
		states,
		summary: pixelSummary(last.pixels, screen),
		warnings: last.rest
			? []
			: [
					"the recording never settles at its end: the last frame is measured while it still changes",
				],
	};
}

/** Measure a video capture's look and write look.json next to its frames. */
export async function writeVideoLook(dir: string): Promise<LookFile> {
	const look = await measureVideoLook(dir);
	await writeLook(dir, look);
	return look;
}
