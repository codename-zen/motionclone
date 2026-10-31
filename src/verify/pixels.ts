import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { ssim } from "ssim.js";
import type { Track } from "../measure/elements.ts";
import type { PixelFrame, PixelResult } from "./schema.ts";

export const DEFAULT_PIXEL_THRESHOLD = 0.02;

export const framePath = (dir: string, frame: number) =>
	join(dir, "frames", `${String(frame).padStart(4, "0")}.png`);

export async function readPng(dir: string, frame: number): Promise<PNG> {
	return PNG.sync.read(await readFile(framePath(dir, frame)));
}

const atRest = (track: Track, i: number) =>
	i > 0 &&
	isDeepStrictEqual(track.frames[i]?.elements, track.frames[i - 1]?.elements);

/** First and last frame, plus the first frame of every run where both tracks are at rest. */
export function restFrames(ref: Track, clone: Track): number[] {
	const n = Math.min(ref.frames.length, clone.frames.length);
	const out = new Set<number>([0, n - 1]);
	let prevRest = true;
	for (let i = 1; i < n - 1; i++) {
		const rest = atRest(ref, i) && atRest(clone, i);
		if (rest && !prevRest) out.add(i);
		prevRest = rest;
	}
	return [...out].sort((a, b) => a - b);
}

function diffImages(a: PNG, b: PNG): { mismatch: number; ssim: number } {
	const count = pixelmatch(a.data, b.data, null, a.width, a.height, {
		threshold: 0.1,
	});
	const image = (p: PNG) => ({
		data: new Uint8ClampedArray(
			p.data.buffer,
			p.data.byteOffset,
			p.data.length,
		),
		width: p.width,
		height: p.height,
	});
	return {
		mismatch: count / (a.width * a.height),
		ssim: ssim(image(a), image(b)).mssim,
	};
}

/** Pixel difference on rest frames only; enforced against the mean mismatch when fidelity is "pixel". */
export async function comparePixels(
	refDir: string,
	cloneDir: string,
	ref: Track,
	clone: Track,
	{ enforced, threshold }: { enforced: boolean; threshold: number },
): Promise<PixelResult> {
	const frames: PixelFrame[] = [];
	for (const frame of restFrames(ref, clone)) {
		const [a, b] = await Promise.all([
			readPng(refDir, frame),
			readPng(cloneDir, frame),
		]);
		if (a.width !== b.width || a.height !== b.height)
			return {
				frames,
				meanMismatch: null,
				meanSsim: null,
				threshold,
				enforced,
				pass: !enforced,
				skipped: `frame sizes differ: reference ${a.width}x${a.height}, clone ${b.width}x${b.height}; capture both with the same clip`,
			};
		frames.push({
			frame,
			t: ref.frames[frame]?.t ?? 0,
			...diffImages(a, b),
		});
	}
	const mean = (k: "mismatch" | "ssim") =>
		frames.reduce((s, f) => s + f[k], 0) / frames.length;
	const meanMismatch = mean("mismatch");
	return {
		frames,
		meanMismatch,
		meanSsim: mean("ssim"),
		threshold,
		enforced,
		pass: !enforced || meanMismatch <= threshold,
		skipped: null,
	};
}

export const skippedPixels = (threshold: number, why: string): PixelResult => ({
	frames: [],
	meanMismatch: null,
	meanSsim: null,
	threshold,
	enforced: false,
	pass: true,
	skipped: `rest-frame pixels not compared: ${why}`,
});
