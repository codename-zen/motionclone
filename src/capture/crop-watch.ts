import type { Track } from "../measure/elements.ts";
import { isEdge } from "../pixel/surface.ts";
import type { ClipRect } from "./options.ts";
import type { TrackedElement, TrackFrame } from "./types.ts";

/** The reference a capture copies with --like: its track and crop. */
export interface CropReference {
	track: Track;
	clip: ClipRect;
}

type Box = Pick<TrackedElement, "x" | "y" | "w" | "h">;

const HIDDEN = 0.01;
// A rebuild's timing is never exact: the reference may leave this many frames earlier or later.
const NEAR_FRAMES = 2;
// Least mean overlap (intersection over union) for a reference element to stand for a tracked one.
const MIN_OVERLAP = 0.3;

const inside = (e: Box, c: ClipRect) =>
	e.x >= c.x &&
	e.y >= c.y &&
	e.x + e.w <= c.x + c.width &&
	e.y + e.h <= c.y + c.height;

function overlap(a: Box, ac: ClipRect, b: Box, bc: ClipRect): number {
	const ax = a.x - ac.x;
	const ay = a.y - ac.y;
	const bx = b.x - bc.x;
	const by = b.y - bc.y;
	const w = Math.min(ax + a.w, bx + b.w) - Math.max(ax, bx);
	const h = Math.min(ay + a.h, by + b.h) - Math.max(ay, by);
	if (w <= 0 || h <= 0) return 0;
	return (w * h) / (a.w * a.h + b.w * b.h - w * h);
}

const keysOf = (frames: readonly TrackFrame[]) => [
	...new Set(
		frames.flatMap((f) =>
			Object.entries(f.elements).flatMap(([sel, list]) =>
				isEdge(sel) ? [] : list.map((e) => `${sel}[${e.index}]`),
			),
		),
	),
];

const find = (f: TrackFrame | undefined, key: string) => {
	const m = /^(.*)\[(\d+)\]$/.exec(key);
	return f?.elements[m?.[1] ?? ""]?.find((e) => e.index === Number(m?.[2]));
};

const nearest = (track: Track, t: number) =>
	Math.max(
		0,
		Math.min(track.frames.length - 1, Math.round(t / (track.frameMs || 1))),
	);

/** The reference element whose box overlaps the tracked element most while both are in view. */
function standIn(
	frames: readonly TrackFrame[],
	key: string,
	crop: ClipRect,
	ref: CropReference,
): string | null {
	let best: string | null = null;
	let bestScore = MIN_OVERLAP;
	for (const k of keysOf(ref.track.frames)) {
		let sum = 0;
		let n = 0;
		for (const f of frames) {
			const e = find(f, key);
			if (!e || e.opacity <= HIDDEN || !inside(e, crop)) continue;
			const r = find(ref.track.frames[nearest(ref.track, f.t)], k);
			if (!r || r.opacity <= HIDDEN || r.observed?.position === false) continue;
			sum += overlap(e, crop, r, ref.clip);
			n++;
		}
		if (n > 0 && sum / n > bestScore) {
			best = k;
			bestScore = sum / n;
		}
	}
	return best;
}

/** True when the reference element is hidden, lost or cut off within a few frames of t. */
function goneNear(ref: CropReference, key: string, t: number): boolean {
	const at = nearest(ref.track, t);
	for (let k = at - NEAR_FRAMES; k <= at + NEAR_FRAMES; k++) {
		const f = ref.track.frames[k];
		if (!f) continue;
		const e = find(f, key);
		if (
			!e ||
			e.opacity <= HIDDEN ||
			e.observed?.position === false ||
			e.clipped === true ||
			!inside(e, ref.clip)
		)
			return true;
	}
	return false;
}

/**
 * One warning per tracked element whose box leaves the crop, for its first such stretch that the reference does not
 * share. An element whose stand-in in the reference is hidden or cut off at the same time leaves on purpose.
 */
export function cropWarnings(
	frames: readonly TrackFrame[],
	crop: ClipRect,
	ref: CropReference | null,
): string[] {
	const out: string[] = [];
	for (const key of keysOf(frames)) {
		const outside = frames.map((f) => {
			const e = find(f, key);
			return !!e && e.w > 0 && e.h > 0 && !inside(e, crop);
		});
		if (!outside.includes(true)) continue;
		const match = ref ? standIn(frames, key, crop, ref) : null;
		const first = frames.findIndex(
			(f, k) => outside[k] && !(ref && match && goneNear(ref, match, f.t)),
		);
		if (first < 0) continue;
		const back = outside.indexOf(false, first);
		const t0 = Math.round(frames[first]?.t ?? 0);
		const span =
			back < 0
				? `from ${t0} ms on`
				: `from ${t0} ms to ${Math.round(frames[back]?.t ?? 0)} ms`;
		out.push(
			match
				? `tracked element ${key} is partly or fully outside the crop ${span}, while the reference shows ${match} in full there; the frames do not show all of ${key}`
				: `tracked element ${key} is partly or fully outside the crop ${span}; the frames do not show all of it. If it leaves the screen on purpose, ignore this`,
		);
	}
	return out;
}
