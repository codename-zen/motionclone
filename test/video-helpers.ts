import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { Answer, type AnswerRow } from "../fixtures/answer-schema.ts";
import type { TrackFrame } from "../src/capture/types.ts";
import type { Track } from "../src/measure/elements.ts";
import { bezierEasing, curveSpanMs, unitCurve } from "../src/spec/easing.ts";
import type { Easing, SpecFile, SpecRow } from "../src/spec/schema.ts";
import { runFfmpegOrThrow } from "../src/video/ffmpeg.ts";

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export const padded = (b: Box, pad: number, scale = 1) => {
	const x = Math.floor((b.x - pad) * scale);
	const y = Math.floor((b.y - pad) * scale);
	return {
		x,
		y,
		w: Math.ceil((b.x + b.w + pad) * scale) - x,
		h: Math.ceil((b.y + b.h + pad) * scale) - y,
	};
};

export const boxAt = (
	frame: TrackFrame | undefined,
	selector: string,
	index: number,
): Box => {
	const e = frame?.elements[selector]?.[index];
	if (!e) throw new Error(`no ${selector}[${index}]`);
	return e;
};

/** The box an element covers from its first to its last frame: start and end positions both inside. */
export function sweep(track: Track, selector: string): Box {
	const a = boxAt(track.frames[0], selector, 0);
	const b = boxAt(track.frames.at(-1), selector, 0);
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		w: Math.max(a.x + a.w, b.x + b.w) - x,
		h: Math.max(a.y + a.h, b.y + b.h) - y,
	};
}

export const answerOf = async (name: string) =>
	Answer.parse(
		JSON.parse(await readFile(`fixtures/${name}/answer.json`, "utf8")),
	);

export const answerEasing = (row: AnswerRow): Easing => {
	if (row.easing.type !== "cubic-bezier")
		throw new Error("expected a bezier key");
	return bezierEasing(row.easing.p);
};

export const timed = (e: Easing, startMs: number, durationMs: number) => {
	const curve = unitCurve(e);
	const span = curveSpanMs(e, durationMs);
	return (t: number) => curve((t - startMs) / span);
};

export const readPng = async (path: string) =>
	PNG.sync.read(await readFile(path));
export const frameFile = (dir: string, k: number) =>
	join(dir, "frames", `${String(k).padStart(4, "0")}.png`);

export const mismatch = (a: PNG, b: PNG) =>
	pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 }) /
	(a.width * a.height);

export const rowOf = (spec: SpecFile, id: string): SpecRow => {
	const row = spec.rows.find((r) => r.id === id);
	if (!row)
		throw new Error(
			`no row ${id}; rows: ${spec.rows.map((r) => r.id).join(", ")}`,
		);
	return row;
};

/** Encode a capture's frames/ directory to a video; `args` are the ffmpeg output options. */
export const encodeFrames = (
	captureDir: string,
	out: string,
	fps: number,
	args: string[],
) =>
	runFfmpegOrThrow([
		"-v",
		"error",
		"-framerate",
		String(fps),
		"-i",
		join(captureDir, "frames", "%04d.png"),
		...args,
		"-y",
		out,
	]);

export const X264 = ["-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p"];
