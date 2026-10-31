import { spawn } from "node:child_process";
import { createRequire } from "node:module";

export interface FfmpegResult {
	code: number;
	stderr: string;
}

// ffmpeg-static is CommonJS and exports the binary path (ffmpeg.exe on Windows) as module.exports.
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as
	| string
	| null;

export function ffmpegBinary(): string {
	if (!ffmpegPath)
		throw new Error("ffmpeg-static has no binary for this platform");
	return ffmpegPath;
}

/** Run ffmpeg with an argument list (no shell, so paths with spaces need no quoting). */
export function runFfmpeg(args: string[]): Promise<FfmpegResult> {
	return new Promise((ok, fail) => {
		const child = spawn(ffmpegBinary(), ["-hide_banner", "-nostdin", ...args], {
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		child.stderr.on("data", (c: Buffer) => chunks.push(c));
		child.on("error", fail);
		child.on("close", (code) =>
			ok({ code: code ?? 1, stderr: Buffer.concat(chunks).toString("utf8") }),
		);
	});
}

export async function runFfmpegOrThrow(args: string[]): Promise<string> {
	const r = await runFfmpeg(args);
	if (r.code !== 0)
		throw new Error(
			`ffmpeg failed (${r.code}): ${r.stderr.trim().split(/\r?\n/).slice(-3).join(" | ")}`,
		);
	return r.stderr;
}

export interface SourceFrame {
	/** Decoder frame number, as the select filter counts it. */
	n: number;
	/** Seconds from the first frame. */
	t: number;
	/** Display duration in seconds, 0 when unknown. */
	duration: number;
}

export interface FrameScan {
	frames: SourceFrame[];
	/** Seconds per timestamp tick of the stream. */
	timeBase: number;
}

const SHOWINFO =
	/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.]+)\s+duration:\s*(-?\d+)\s+duration_time:\s*(-?[\d.]+)/g;

export function parseShowinfo(stderr: string): FrameScan {
	const raw: { n: number; pts: number; t: number; duration: number }[] = [];
	for (const m of stderr.matchAll(SHOWINFO))
		raw.push({
			n: Number(m[1]),
			pts: Number(m[2]),
			t: Number(m[3]),
			duration: Math.max(0, Number(m[5])),
		});
	const ref = raw.reduce(
		(best, f) => (Math.abs(f.pts) > Math.abs(best.pts) ? f : best),
		raw[0] ?? { pts: 0, t: 0 },
	);
	const timeBase = ref.pts !== 0 ? ref.t / ref.pts : 0;
	const t0 = raw[0]?.t ?? 0;
	return {
		frames: raw.map((f) => ({ n: f.n, t: f.t - t0, duration: f.duration })),
		timeBase,
	};
}

/** Decode the first video stream once and read every frame's timestamp. */
export async function scanFrames(input: string): Promise<FrameScan> {
	const stderr = await runFfmpegOrThrow([
		"-nostats",
		"-i",
		input,
		"-map",
		"0:v:0",
		"-vf",
		"showinfo",
		"-fps_mode",
		"passthrough",
		"-f",
		"null",
		"-",
	]);
	const scan = parseShowinfo(stderr);
	if (scan.frames.length === 0) throw new Error(`no video frames in ${input}`);
	return scan;
}
