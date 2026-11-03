import { changeWindows } from "../pixel/activity.ts";
import { readPng } from "../verify/pixels.ts";

export interface RestFrame {
	label: "first" | "plateau" | "last";
	frame: number;
	/** False for a last frame that still changes. */
	rest: boolean;
}

// A still run between two changes this short is a pause inside one motion, not a state of the design.
const PLATEAU_MS = 150;

/** The middle of the still run before the changes and of every plateau between them, and the last frame. */
export function restStates(
	activity: readonly number[],
	frameMs: number,
): RestFrame[] {
	const n = activity.length;
	const windows = changeWindows(activity, frameMs);
	const runs: [number, number][] = [];
	let start = 0;
	for (const w of windows) {
		runs.push([start, w.from]);
		start = w.to;
	}
	const out: RestFrame[] = [];
	runs.forEach(([a, b], i) => {
		if (b - a < 1 || (i > 0 && (b - a) * frameMs < PLATEAU_MS)) return;
		out.push({
			label: i === 0 ? "first" : "plateau",
			frame: Math.round((a + b) / 2),
			rest: true,
		});
	});
	out.push({ label: "last", frame: n - 1, rest: n - 1 - start >= 1 });
	return out;
}

// The frame is split into TILES x TILES tiles; a small element changing is a large change of its tile.
const TILES = 8;
const MAX_SAMPLES = 160_000;

/** Per frame, the largest mean RGB change of any tile since the previous frame; reads one frame at a time. */
export async function tileActivity(
	dir: string,
	frames: number,
): Promise<number[]> {
	const out: number[] = [];
	let prev: Uint8Array | null = null;
	for (let k = 0; k < frames; k++) {
		const png = await readPng(dir, k);
		const step = Math.max(
			1,
			Math.ceil(Math.sqrt((png.width * png.height) / MAX_SAMPLES)),
		);
		const cols = Math.ceil(png.width / step);
		const rows = Math.ceil(png.height / step);
		const cur = new Uint8Array(cols * rows * 3);
		let o = 0;
		for (let y = 0; y < png.height; y += step)
			for (let x = 0; x < png.width; x += step) {
				const p = (y * png.width + x) * 4;
				cur[o++] = png.data[p] as number;
				cur[o++] = png.data[p + 1] as number;
				cur[o++] = png.data[p + 2] as number;
			}
		if (!prev) out.push(0);
		else {
			const sum = new Float64Array(TILES * TILES);
			const count = new Float64Array(TILES * TILES);
			for (let y = 0; y < rows; y++)
				for (let x = 0; x < cols; x++) {
					const t =
						Math.floor((y * TILES) / rows) * TILES +
						Math.floor((x * TILES) / cols);
					const i = (y * cols + x) * 3;
					sum[t] =
						(sum[t] as number) +
						Math.abs((cur[i] as number) - (prev[i] as number)) +
						Math.abs((cur[i + 1] as number) - (prev[i + 1] as number)) +
						Math.abs((cur[i + 2] as number) - (prev[i + 2] as number));
					count[t] = (count[t] as number) + 3;
				}
			let max = 0;
			for (let t = 0; t < sum.length; t++)
				if (count[t])
					max = Math.max(max, (sum[t] as number) / (count[t] as number));
			out.push(max);
		}
		prev = cur;
	}
	return out;
}

/** Rest frames of a capture from the change of its busiest tile. */
export async function restFramesOf(
	dir: string,
	frames: number,
	frameMs: number,
): Promise<RestFrame[]> {
	return restStates(await tileActivity(dir, frames), frameMs);
}
