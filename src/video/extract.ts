import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeVideoCaptureFile } from "./capture-file.ts";
import { type FrameScan, runFfmpegOrThrow, scanFrames } from "./ffmpeg.ts";
import {
	type ExtractInput,
	ExtractOptions,
	type PixelRect,
} from "./options.ts";
import { probeVideo, type VideoProbe } from "./probe.ts";

export const MAX_DEFAULT_FPS = 60;
// Same cap as DOM captures.
export const MAX_FRAMES = 3000;

export interface ExtractResult {
	outDir: string;
	probe: VideoProbe;
	frames: number;
	fps: number;
	frameMs: number;
	/** Seconds from the first source frame. */
	start: number;
	end: number;
	crop: PixelRect;
	/** Output frame pixels per cropped source pixel. */
	scale: number;
	cssScale: number;
	/** Output frame size in pixels. */
	width: number;
	height: number;
	/** Decoder frame number used for each output frame. */
	sourceFrames: number[];
	warnings: string[];
}

const name = (k: number) => `${String(k).padStart(4, "0")}.png`;

/**
 * Output frame k shows the source frame on screen at start + k / fps: the last frame whose timestamp is at or
 * before that instant. Half a timestamp tick of slack absorbs containers that round times (gif centiseconds).
 */
export function pickFrames(
	scan: FrameScan,
	start: number,
	fps: number,
	count: number,
): number[] {
	const slack = Math.max(0.0005, scan.timeBase / 2);
	const out: number[] = [];
	let i = 0;
	for (let k = 0; k < count; k++) {
		const at = start + k / fps + slack;
		while (
			i + 1 < scan.frames.length &&
			(scan.frames[i + 1]?.t ?? Infinity) <= at
		)
			i++;
		out.push((scan.frames[i] as { n: number }).n);
	}
	return out;
}

function checkCrop(crop: PixelRect | undefined, probe: VideoProbe): PixelRect {
	const full = { x: 0, y: 0, w: probe.width, h: probe.height };
	if (!crop) return full;
	if (crop.x + crop.w > probe.width || crop.y + crop.h > probe.height)
		throw new Error(
			`crop ${JSON.stringify(crop)} lies outside the ${probe.width}x${probe.height} video`,
		);
	return crop;
}

/** Extract lossless PNG frames on an exact start + k / fps grid and write capture.json. */
export async function extractFrames(
	input: ExtractInput,
): Promise<ExtractResult> {
	const opts = ExtractOptions.parse(input);
	const src = resolve(opts.input);
	const outDir = resolve(opts.outDir);
	const warnings: string[] = [];
	const probe = await probeVideo(src);
	const scan = await scanFrames(src);
	const crop = checkCrop(opts.crop, probe);
	const fps = opts.fps ?? Math.min(probe.fps, MAX_DEFAULT_FPS);
	if (!opts.fps && probe.fps > MAX_DEFAULT_FPS)
		warnings.push(`source runs at ${probe.fps} fps; extracted at ${fps} fps`);

	const lastT = scan.frames.at(-1)?.t ?? 0;
	let end = opts.end ?? lastT;
	if (end > lastT) {
		warnings.push(`end ${end}s is past the last frame (${lastT}s); clamped`);
		end = lastT;
	}
	if (opts.start > end)
		throw new Error(`start ${opts.start}s is after the end (${end}s)`);
	let count = Math.floor((end - opts.start) * fps + 1e-9) + 1;
	if (count > MAX_FRAMES) {
		count = MAX_FRAMES;
		warnings.push(`extraction truncated to ${MAX_FRAMES} frames`);
	}
	const sourceFrames = pickFrames(scan, opts.start, fps, count);

	const width = opts.width ?? crop.w;
	const height = opts.width
		? Math.max(1, Math.round((crop.h * opts.width) / crop.w))
		: crop.h;
	const first = sourceFrames[0] as number;
	const last = sourceFrames.at(-1) as number;
	const filters = [`select='between(n,${first},${last})'`];
	if (crop.w !== probe.width || crop.h !== probe.height)
		filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
	if (width !== crop.w || height !== crop.h)
		filters.push(`scale=${width}:${height}`);

	const framesDir = join(outDir, "frames");
	const tmp = join(outDir, ".frames-tmp");
	await rm(framesDir, { recursive: true, force: true });
	await rm(tmp, { recursive: true, force: true });
	await mkdir(framesDir, { recursive: true });
	await mkdir(tmp, { recursive: true });
	try {
		await runFfmpegOrThrow([
			"-v",
			"error",
			"-i",
			src,
			"-map",
			"0:v:0",
			"-sws_flags",
			"lanczos+accurate_rnd+full_chroma_int",
			"-vf",
			filters.join(","),
			"-fps_mode",
			"passthrough",
			"-frames:v",
			String(last - first + 1),
			"-start_number",
			String(first),
			"-pix_fmt",
			"rgb24",
			join(tmp, "%06d.png"),
		]);
		const written = new Set(await readdir(tmp));
		const lastUse = new Map(sourceFrames.map((n, k) => [n, k]));
		for (const [k, n] of sourceFrames.entries()) {
			const file = `${String(n).padStart(6, "0")}.png`;
			if (!written.has(file))
				throw new Error(`ffmpeg did not write source frame ${n}`);
			const from = join(tmp, file);
			if (lastUse.get(n) === k) await rename(from, join(framesDir, name(k)));
			else await copyFile(from, join(framesDir, name(k)));
		}
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}

	const result: ExtractResult = {
		outDir,
		probe,
		frames: count,
		fps,
		frameMs: 1000 / fps,
		start: opts.start,
		end,
		crop,
		scale: width / crop.w,
		cssScale: opts.cssScale,
		width,
		height,
		sourceFrames,
		warnings,
	};
	await writeVideoCaptureFile(result, { track: [], warnings });
	return result;
}
