import { type Activity, BLOCK } from "./activity.ts";
import type { PixelRect } from "./options.ts";

export interface MotionWindow {
	/** Decoded frame indices: the last still frame before the motion and the first still frame after it. */
	fromFrame: number;
	toFrame: number;
	/** Seconds from the first source frame. */
	from: number;
	to: number;
	/** Largest share of the area that changed in one frame step. */
	peak: number;
}

// Pauses up to this many frame steps inside one motion do not split it.
const BRIDGE = 2;

/** Changed pixels inside `rect` per frame step (index k: between frame k - 1 and k). */
export function changedPixels(a: Activity, rect: PixelRect): number[] {
	const bx0 = Math.floor(rect.x / BLOCK);
	const by0 = Math.floor(rect.y / BLOCK);
	const bx1 = Math.ceil((rect.x + rect.w) / BLOCK);
	const by1 = Math.ceil((rect.y + rect.h) / BLOCK);
	return a.changes.map((blocks) => {
		let n = 0;
		for (let by = by0; by < by1; by++)
			for (let bx = bx0; bx < bx1; bx++)
				n += blocks[by * a.cols + bx] as number;
		return n;
	});
}

/** Stretches of frames where the area inside `rect` changes, from the still frame before to the still frame after. */
export function motionWindows(a: Activity, rect: PixelRect): MotionWindow[] {
	const counts = changedPixels(a, rect);
	const area = rect.w * rect.h;
	const sorted = counts.slice(1).sort((p, q) => p - q);
	const quiet = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
	const threshold = Math.max(16, area * 0.0005, quiet * 3);
	const out: MotionWindow[] = [];
	let open: { first: number; last: number; peak: number } | null = null;
	const close = () => {
		if (!open) return;
		const fromFrame = open.first - 1;
		const toFrame = open.last;
		out.push({
			fromFrame,
			toFrame,
			from: a.times[fromFrame] as number,
			to: a.times[toFrame] as number,
			peak: open.peak / area,
		});
		open = null;
	};
	for (let k = 1; k < counts.length; k++) {
		const c = counts[k] as number;
		if (c < threshold) {
			if (open && k - open.last > BRIDGE) close();
			continue;
		}
		if (open) {
			open.last = k;
			open.peak = Math.max(open.peak, c);
		} else open = { first: k, last: k, peak: c };
	}
	close();
	return out;
}
