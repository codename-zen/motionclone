import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { readCaptureFile } from "../spec/capture-file.ts";
import { framePath } from "../verify/pixels.ts";

/** A capture directory seen as frames on a time line where 0 ms is the trigger. */
export interface Clip {
	dir: string;
	frames: number;
	frameMs: number;
	triggerAtMs: number;
}

export async function readClip(dir: string): Promise<Clip> {
	let cap: Awaited<ReturnType<typeof readCaptureFile>>;
	try {
		cap = await readCaptureFile(dir);
	} catch {
		throw new Error(`no capture.json in ${dir}; capture it first`);
	}
	if (cap.frames < 1) throw new Error(`${dir} has no frames`);
	return {
		dir,
		frames: cap.frames,
		frameMs: cap.frameMs,
		triggerAtMs: cap.triggerAtMs,
	};
}

/** Time of a frame, in ms from the trigger. */
export const frameTime = (c: Clip, i: number): number =>
	i * c.frameMs - c.triggerAtMs;

export const firstTime = (c: Clip): number => frameTime(c, 0);
export const lastTime = (c: Clip): number => frameTime(c, c.frames - 1);

/** Nearest frame to a time, clamped to the capture. */
export const frameAt = (c: Clip, t: number): number =>
	Math.max(
		0,
		Math.min(c.frames - 1, Math.round((t + c.triggerAtMs) / c.frameMs)),
	);

/** Decodes frames of one clip, keeping the last one so repeated times cost nothing. */
export class FrameReader {
	private last: { index: number; png: PNG } | null = null;

	readonly clip: Clip;

	constructor(clip: Clip) {
		this.clip = clip;
	}

	async read(index: number): Promise<PNG> {
		if (this.last?.index === index) return this.last.png;
		const png = PNG.sync.read(await readFile(framePath(this.clip.dir, index)));
		this.last = { index, png };
		return png;
	}
}
