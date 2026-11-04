import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { readTrack } from "../measure/elements.ts";
import { readCaptureFile } from "../spec/capture-file.ts";
import { framePath } from "../verify/pixels.ts";

/** A capture directory seen as frames on a time line where 0 ms is the trigger. */
export interface Clip {
	dir: string;
	frames: number;
	frameMs: number;
	triggerAtMs: number;
	/** Time of each frame in ms from the trigger, as the capture's track recorded it. */
	times: number[];
}

/** The track's own time per frame; captures without a usable track fall back to a fixed step from the trigger. */
async function frameTimes(
	dir: string,
	frames: number,
	fallback: (i: number) => number,
): Promise<number[]> {
	try {
		const times = new Array<number>(frames);
		for (const f of (await readTrack(dir)).frames)
			if (f.frame >= 0 && f.frame < frames && Number.isFinite(f.t))
				times[f.frame] = f.t;
		if (times.every((t, i) => i === 0 || t > (times[i - 1] as number)))
			return times;
	} catch {
		// no track.json
	}
	return Array.from({ length: frames }, (_, i) => fallback(i));
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
		times: await frameTimes(
			dir,
			cap.frames,
			(i) => i * cap.frameMs - cap.triggerAtMs,
		),
	};
}

/** Time of a frame, in ms from the trigger. */
export const frameTime = (c: Clip, i: number): number => c.times[i] as number;

export const firstTime = (c: Clip): number => frameTime(c, 0);
export const lastTime = (c: Clip): number => frameTime(c, c.frames - 1);

/** Nearest frame to a time, clamped to the capture. */
export function frameAt(c: Clip, t: number): number {
	let lo = 0;
	let hi = c.frames - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (frameTime(c, mid) < t) lo = mid + 1;
		else hi = mid;
	}
	const before = lo > 0 ? lo - 1 : lo;
	return t - frameTime(c, before) < frameTime(c, lo) - t ? before : lo;
}

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
