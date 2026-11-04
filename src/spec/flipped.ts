import type { Track } from "../measure/elements.ts";
import type { Span } from "../pixel/measure.ts";

/**
 * Runs of frames where a video tracker found light and dark around an element swapped (ADR 0002), each as the span
 * between the frames beside it: appearance there is read against the other backdrop.
 */
export function flippedSpans(
	track: Track,
	selector: string,
	index: number,
): Span[] {
	const out: Span[] = [];
	let first: number | null = null;
	let last = 0;
	const close = (next: number) => {
		if (first !== null) out.push({ firstMs: first, lastMs: next });
		first = null;
	};
	track.frames.forEach((f, k) => {
		const e = f.elements[selector]?.find((x) => x.index === index);
		if (e?.flipped) {
			if (first === null) first = track.frames[k - 1]?.t ?? f.t - track.frameMs;
			last = f.t;
		} else if (first !== null) close(f.t);
	});
	close(last + track.frameMs);
	return out;
}

// Box moves under this, CSS px, are tracker jitter.
const STILL_PX = 0.5;

/** The element's box stays in place from one time to another. */
export function holdsStill(
	track: Track,
	selector: string,
	index: number,
	fromMs: number,
	toMs: number,
): boolean {
	const boxes = track.frames
		.filter((f) => f.t >= fromMs && f.t <= toMs)
		.flatMap(
			(f) => f.elements[selector]?.filter((e) => e.index === index) ?? [],
		);
	const first = boxes[0];
	return (
		first !== undefined &&
		boxes.every(
			(b) =>
				Math.abs(b.x - first.x) <= STILL_PX &&
				Math.abs(b.y - first.y) <= STILL_PX &&
				Math.abs(b.w - first.w) <= STILL_PX &&
				Math.abs(b.h - first.h) <= STILL_PX,
		)
	);
}
