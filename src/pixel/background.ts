import { activityCurve, changeWindows } from "./activity.ts";
import { type ProgressWindow, progressWindows } from "./progress.ts";

// A pixel whose two rest frames differ by less than this, mean RGB levels, did not change.
const CHANGED = 16;
// Pixels within this many levels per channel of the start and end colours show the background.
const SAME_COLOUR = 24;
// A background change covers at least this share of the region's pixels.
const MIN_SHARE = 0.05;

type Rgb = [number, number, number];

const at = (f: Uint8Array, i: number, c: number) => f[i * 3 + c] as number;

const levels = (f: Uint8Array, i: number, c: Rgb) =>
	(Math.abs(at(f, i, 0) - c[0]) +
		Math.abs(at(f, i, 1) - c[1]) +
		Math.abs(at(f, i, 2) - c[2])) /
	3;

const near = (f: Uint8Array, i: number, c: Rgb) =>
	Math.abs(at(f, i, 0) - c[0]) <= SAME_COLOUR &&
	Math.abs(at(f, i, 1) - c[1]) <= SAME_COLOUR &&
	Math.abs(at(f, i, 2) - c[2]) <= SAME_COLOUR;

/** The most common colour of some pixels, binned by 16 levels per channel, as the mean of its bin. */
function modeColour(f: Uint8Array, pixels: readonly number[]): Rgb {
	const bins = new Map<number, number[]>();
	for (const i of pixels) {
		const key =
			(at(f, i, 0) >> 4) * 256 + (at(f, i, 1) >> 4) * 16 + (at(f, i, 2) >> 4);
		const list = bins.get(key);
		if (list) list.push(i);
		else bins.set(key, [i]);
	}
	let best: number[] = [];
	for (const list of bins.values()) if (list.length > best.length) best = list;
	const mean = (c: number) =>
		best.reduce((s, i) => s + at(f, i, c), 0) / Math.max(1, best.length);
	return [mean(0), mean(1), mean(2)];
}

// Background pixels of one change that cross half way on the same frame, as the most do.
function switchingTogether(
	frames: readonly Uint8Array[],
	from: number,
	to: number,
): number[] {
	const a = frames[from] as Uint8Array;
	const b = frames[to] as Uint8Array;
	const n = a.length / 3;
	const changed: number[] = [];
	for (let i = 0; i < n; i++)
		if (levels(a, i, [at(b, i, 0), at(b, i, 1), at(b, i, 2)]) >= CHANGED)
			changed.push(i);
	if (changed.length < MIN_SHARE * n) return [];
	const start = modeColour(a, changed);
	const end = modeColour(b, changed);
	const span =
		(Math.abs(start[0] - end[0]) +
			Math.abs(start[1] - end[1]) +
			Math.abs(start[2] - end[2])) /
		3;
	if (span < CHANGED) return [];
	const byFrame = new Map<number, number[]>();
	for (const i of changed) {
		if (!near(a, i, start) || !near(b, i, end)) continue;
		for (let k = from + 1; k <= to; k++)
			if (levels(frames[k] as Uint8Array, i, end) <= span / 2) {
				const list = byFrame.get(k);
				if (list) list.push(i);
				else byFrame.set(k, [i]);
				break;
			}
	}
	let peak = -1;
	for (const [k, list] of byFrame)
		if (peak < 0 || list.length > (byFrame.get(peak)?.length ?? 0)) peak = k;
	const group = byFrame.get(peak) ?? [];
	return group.length >= MIN_SHARE * n ? group : [];
}

const pick = (f: Uint8Array, pixels: readonly number[]) => {
	const out = new Uint8Array(pixels.length * 3);
	pixels.forEach((i, o) => {
		out[o * 3] = at(f, i, 0);
		out[o * 3 + 1] = at(f, i, 1);
		out[o * 3 + 2] = at(f, i, 2);
	});
	return out;
};

/**
 * Changes of a background region: per change, the pixels that switch from one flat colour to another on the same
 * frame, read apart from content that moves across the region meanwhile, such as a sheet sliding over it.
 */
export function backgroundWindows(
	frames: readonly Uint8Array[],
	t: readonly number[],
	frameMs: number,
): ProgressWindow[] {
	return changeWindows(activityCurve(frames), frameMs).flatMap((w) => {
		const group = switchingTogether(frames, w.from, w.to);
		if (group.length === 0) return [];
		const own = progressWindows(
			frames.map((f) => pick(f, group)),
			t,
			frameMs,
		);
		return own.filter(
			(g) => g.fromFrame >= w.from - 1 && g.toFrame <= w.to + 1,
		);
	});
}
