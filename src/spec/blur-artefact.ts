import type { Track } from "../measure/elements.ts";
import type { DroppedRow, SpecRow } from "./schema.ts";

// An opacity change under this share of the full range (0..1) can be contrast lost to motion blur or compression.
const MAX_CHANGE = 0.15;
// Readings this far under the end value count as dimmed.
const DIM = 0.02;
// A box moving at least this many CSS px per frame smears its edges and text.
const BLUR_SPEED = 0.5;
const POSITION = new Set([
	"x",
	"y",
	"width",
	"height",
	"translateX",
	"translateY",
]);

type Box = { x: number; y: number; w: number; h: number };

/** CSS px per frame the element's box moves on frame k, centred over its neighbours. */
function speedAt(boxes: (Box | undefined)[], k: number): number {
	const a = boxes[Math.max(0, k - 1)];
	const b = boxes[Math.min(boxes.length - 1, k + 1)];
	if (!a || !b) return 0;
	const steps = Math.min(boxes.length - 1, k + 1) - Math.max(0, k - 1) || 1;
	const d = Math.max(
		Math.abs(b.x - a.x),
		Math.abs(b.y - a.y),
		Math.abs(b.x + b.w - a.x - a.w),
		Math.abs(b.y + b.h - a.y - a.h),
	);
	return d / steps;
}

/**
 * Why a video opacity row is motion blur clearing at the end of the element's own slide rather than a fade, or null.
 * It must be a small rise that starts while a position row of the element runs, with every dimmed reading on a frame
 * where the box still moves.
 */
export function blurArtefact(
	row: SpecRow,
	rows: readonly SpecRow[],
	track: Track,
	frameMs: number,
): string | null {
	if (row.property !== "opacity" || row.source === "declared") return null;
	const change = row.to - row.from;
	if (change <= 0 || change >= MAX_CHANGE) return null;
	const end = row.startMs + row.durationMs;
	const slide = rows.find(
		(r) =>
			r.selector === row.selector &&
			r.index === row.index &&
			POSITION.has(r.property) &&
			row.startMs >= r.startMs - frameMs &&
			row.startMs <= r.startMs + r.durationMs + 2 * frameMs,
	);
	if (!slide) return null;
	const boxes = track.frames.map((f) =>
		f.elements[row.selector]?.find((e) => e.index === row.index),
	);
	let dimmed = 0;
	for (const [k, f] of track.frames.entries()) {
		if (f.t < row.startMs - frameMs || f.t > end + frameMs) continue;
		const e = boxes[k];
		if (!e || e.observed?.opacity === false || e.opacity >= row.to - DIM)
			continue;
		if (speedAt(boxes, k) < BLUR_SPEED) return null;
		dimmed++;
	}
	if (dimmed === 0) return null;
	return `motion blur, not a fade: opacity rises ${row.from} -> ${row.to} (${Math.round(change * 100)} % of its range) as ${slide.id} comes to rest, and on all ${dimmed} dimmed frames the box still moves ${BLUR_SPEED} px a frame or more; the rebuild needs no opacity change here`;
}

/** Rows without video blur artefacts; those go to `dropped` with their reason. */
export function dropBlurArtefacts(
	rows: readonly SpecRow[],
	track: Track,
	frameMs: number,
	dropped: DroppedRow[],
): SpecRow[] {
	return rows.filter((row) => {
		const reason = blurArtefact(row, rows, track, frameMs);
		if (reason === null) return true;
		dropped.push({
			id: row.id,
			selector: row.selector,
			index: row.index,
			property: row.property,
			reason,
		});
		return false;
	});
}
