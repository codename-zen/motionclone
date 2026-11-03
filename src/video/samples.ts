import type { Plane } from "./luma.ts";
import type { Rect } from "./match.ts";
import type { Status } from "./quality.ts";

/** Which reading placed the element: the template, its colour box, or both (agreeing or not); none when neither. */
export type Method = "template" | "colour" | "both-agree" | "disagree" | "none";

export interface RegionSample {
	/** The position is measured: status found or faint. */
	found: boolean;
	/** Shift of the box centre from its reference-frame position, frame pixels. */
	dx: number;
	dy: number;
	/** Uniform scale against the reference-frame box. */
	scale: number;
	/** Gaussian blur standard deviation in the element's own space, reference-frame pixels. */
	blur: number;
	ncc: number;
	/** Opacity proxy, 0..1: contrast against the reference appearance at this scale and blur, 0 when not found. */
	opacity: number;
	/** Share of the patch's structure the model explains, scaled down when the model is near the noise, 0..1. */
	quality: number;
	status: Status;
	method: Method;
	/** Centroid of change against frame 0 inside the box, frame pixels; null when nothing changed. */
	centroid: { x: number; y: number } | null;
	/** Mean absolute luma change from the previous frame inside the box. */
	energy: number;
}

export interface RegionTrack {
	name: string;
	/** Element box in the reference frame, frame pixels. */
	box: Rect;
	ref: "first" | "last";
	samples: RegionSample[];
}

/** The reference box moved and scaled about its centre as a sample says. */
export function sampleBox(box: Rect, s: RegionSample): Rect {
	const w = box.w * s.scale;
	const h = box.h * s.scale;
	return {
		x: box.x + box.w / 2 + s.dx - w / 2,
		y: box.y + box.h / 2 + s.dy - h / 2,
		w,
		h,
	};
}

export function changeStats(cur: Plane, base: Plane, r: Rect, floor: number) {
	let sum = 0;
	let wsum = 0;
	let wx = 0;
	let wy = 0;
	const x0 = Math.max(0, Math.round(r.x));
	const y0 = Math.max(0, Math.round(r.y));
	const x1 = Math.min(cur.width, x0 + Math.round(r.w));
	const y1 = Math.min(cur.height, y0 + Math.round(r.h));
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const o = y * cur.width + x;
			const d = Math.abs((cur.data[o] as number) - (base.data[o] as number));
			sum += d;
			const w = Math.max(0, d - floor);
			wsum += w;
			wx += w * x;
			wy += w * y;
		}
	const n = Math.max(1, (x1 - x0) * (y1 - y0));
	return {
		mean: sum / n,
		centroid: wsum > 0 ? { x: wx / wsum, y: wy / wsum } : null,
	};
}
