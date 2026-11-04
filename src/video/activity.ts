import { scanFrames } from "./ffmpeg.ts";
import type { VideoProbe } from "./probe.ts";
import { decodeRaw } from "./raw.ts";

// Luma change between frames that counts as motion; h264 noise on still areas stays well below it.
export const CHANGE = 12;
export const BLOCK = 16;
// Long clips are sampled down to about this many frames.
const MAX_FRAMES = 900;

/** Where and when a recording changes, from its luma frames. */
export interface Activity {
	width: number;
	height: number;
	/** Mean luma per pixel over the decoded frames. */
	mean: Float32Array;
	/** Per pixel: how many frame-to-frame steps changed it by more than CHANGE. */
	moves: Uint16Array;
	/** Decoded frames; every `step`-th source frame. */
	frames: number;
	step: number;
	/** Seconds from the first source frame, per decoded frame. */
	times: number[];
	/** Blocks of BLOCK x BLOCK pixels, row-major, `cols` per row. */
	cols: number;
	rows: number;
	/** Per decoded frame k: changed pixels per block between frame k - 1 and k (all zero for k = 0). */
	changes: Uint16Array[];
}

export async function measureActivity(
	path: string,
	probe: VideoProbe,
): Promise<Activity> {
	const { width, height } = probe;
	const scan = await scanFrames(path);
	const step = Math.max(1, Math.ceil(scan.frames.length / MAX_FRAMES));
	const n = width * height;
	const sum = new Float64Array(n);
	const moves = new Uint16Array(n);
	const prev = new Uint8Array(n);
	const cols = Math.ceil(width / BLOCK);
	const rows = Math.ceil(height / BLOCK);
	const changes: Uint16Array[] = [];
	const frames = await decodeRaw(
		path,
		{
			width,
			height,
			pixFmt: "gray",
			bytesPerPixel: 1,
			filters: step > 1 ? `select='not(mod(n,${step}))'` : undefined,
		},
		(f, k) => {
			const blocks = new Uint16Array(cols * rows);
			for (let y = 0; y < height; y++) {
				const row = y * width;
				const brow = Math.floor(y / BLOCK) * cols;
				for (let x = 0; x < width; x++) {
					const i = row + x;
					const v = f[i] as number;
					sum[i] = (sum[i] as number) + v;
					if (k > 0 && Math.abs(v - (prev[i] as number)) > CHANGE) {
						moves[i] = (moves[i] as number) + 1;
						const b = brow + Math.floor(x / BLOCK);
						blocks[b] = (blocks[b] as number) + 1;
					}
				}
			}
			prev.set(f);
			changes.push(blocks);
		},
	);
	if (frames === 0) throw new Error(`no video frames in ${path}`);
	const mean = new Float32Array(n);
	for (let i = 0; i < n; i++) mean[i] = (sum[i] as number) / frames;
	const times = Array.from(
		{ length: frames },
		(_, k) => scan.frames[Math.min(k * step, scan.frames.length - 1)]?.t ?? 0,
	);
	return {
		width,
		height,
		mean,
		moves,
		frames,
		step,
		times,
		cols,
		rows,
		changes,
	};
}
