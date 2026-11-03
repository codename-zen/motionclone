import type { ClipRect } from "../capture/options.ts";
import type { Track } from "../measure/elements.ts";

/** A box in CSS px, in the coordinates of the track's element boxes. */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Frame pixels: columns x0..x1-1 and rows y0..y1-1, read every `step` pixels along both axes. */
export interface FrameRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	step: number;
}

// A mean difference needs far fewer pixels than a large region holds; sampling bounds memory per frame.
const MAX_SAMPLES = 40_000;

/** A CSS box in frame pixels: the clip offset removed, scaled by the frame's device pixels per CSS px. */
export function toFrameRect(
	r: Rect,
	clip: ClipRect,
	frame: { width: number; height: number },
): FrameRect | null {
	const scale = frame.width / clip.width;
	const x0 = Math.max(0, Math.floor((r.x - clip.x) * scale));
	const y0 = Math.max(0, Math.floor((r.y - clip.y) * scale));
	const x1 = Math.min(frame.width, Math.ceil((r.x + r.w - clip.x) * scale));
	const y1 = Math.min(frame.height, Math.ceil((r.y + r.h - clip.y) * scale));
	if (x1 <= x0 || y1 <= y0) return null;
	const step = Math.max(
		1,
		Math.ceil(Math.sqrt(((x1 - x0) * (y1 - y0)) / MAX_SAMPLES)),
	);
	return { x0, y0, x1, y1, step };
}

/** Every box an element has over the capture, joined: the region its appearance is measured in. */
export function elementRegion(
	track: Track,
	selector: string,
	index: number,
): Rect | null {
	let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
	for (const f of track.frames) {
		const e = f.elements[selector]?.find((x) => x.index === index);
		if (!e || e.w <= 0 || e.h <= 0) continue;
		box = box
			? {
					x0: Math.min(box.x0, e.x),
					y0: Math.min(box.y0, e.y),
					x1: Math.max(box.x1, e.x + e.w),
					y1: Math.max(box.y1, e.y + e.h),
				}
			: { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h };
	}
	return box
		? { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 }
		: null;
}

export const contains = (outer: Rect, inner: Rect) =>
	inner.x >= outer.x &&
	inner.y >= outer.y &&
	inner.x + inner.w <= outer.x + outer.w &&
	inner.y + inner.h <= outer.y + outer.h;

export const overlaps = (a: Rect, b: Rect) =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
