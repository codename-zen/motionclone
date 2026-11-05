import type { Rect } from "./match.ts";
import { type RegionSample, type RegionTrack, sampleBox } from "./samples.ts";

// A box edge within this many pixels of the region edge touches it.
export const TOUCH = 1;
// The box centre moves more than this many pixels from the neighbouring frame: the element is still moving.
const MOVING = 0.5;

/**
 * How far the box reaches past the region on its worst side; negative while it stays inside. Sides where the
 * region ends at the frame edge do not count: there the frame cuts the content, not the region. With `towards`,
 * only the sides the element moves towards count.
 */
export function overreach(
	b: Rect,
	r: Rect,
	frame: Rect,
	towards: { x: number; y: number } | null = null,
): number {
	const none = Number.NEGATIVE_INFINITY;
	const side = (on: boolean, v: number) => (on ? v : none);
	const all = towards === null;
	return Math.max(
		side(r.x > frame.x && (all || towards.x < 0), r.x - b.x),
		side(r.y > frame.y && (all || towards.y < 0), r.y - b.y),
		side(
			r.x + r.w < frame.x + frame.w && (all || towards.x > 0),
			b.x + b.w - (r.x + r.w),
		),
		side(
			r.y + r.h < frame.y + frame.h && (all || towards.y > 0),
			b.y + b.h - (r.y + r.h),
		),
	);
}

const centre = (t: RegionTrack, p: RegionSample) => ({
	x: t.box.x + t.box.w / 2 + p.dx,
	y: t.box.y + t.box.h / 2 + p.dy,
});

/**
 * The centre's motion between frame k and a found neighbour, when it moves more than MOVING; else null. Components
 * under MOVING are jitter across the motion and read as 0.
 */
function motion(t: RegionTrack, k: number): { x: number; y: number } | null {
	const p = t.samples[k] as RegionSample;
	for (const j of [k - 1, k + 1]) {
		const q = t.samples[j];
		if (!q?.found) continue;
		const a = centre(t, p);
		const b = centre(t, q);
		const d =
			j > k ? { x: b.x - a.x, y: b.y - a.y } : { x: a.x - b.x, y: a.y - b.y };
		const along = (v: number) => (Math.abs(v) > MOVING ? v : 0);
		if (Math.hypot(d.x, d.y) > MOVING) return { x: along(d.x), y: along(d.y) };
	}
	return null;
}

/**
 * Mark found frames where the box reaches a region edge inside the frame while the element moves, or lies past
 * it, and the frames lost next to them: the region cut the travel there, so the position is not a reading of the whole move.
 * Returns the frame ranges, also kept on the track.
 */
export function markClipped(
	t: RegionTrack,
	region: Rect,
	frame: Rect,
): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];
	t.samples.forEach((p, k) => {
		if (!p.found) return;
		const box = sampleBox(t.box, p);
		const d = motion(t, k);
		// A box that touches a side clips the travel only while it moves towards that side.
		const touching = d !== null && overreach(box, region, frame, d) > -TOUCH;
		if (!(overreach(box, region, frame) > TOUCH || touching)) return;
		// Frames lost next to a clipped one are where the element left the region.
		let from = k;
		let to = k;
		while (from > 0 && !t.samples[from - 1]?.found) from--;
		while (to < t.samples.length - 1 && !t.samples[to + 1]?.found) to++;
		const last = ranges.at(-1);
		if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
		else ranges.push({ from, to });
	});
	for (const r of ranges)
		for (let k = r.from; k <= r.to; k++)
			(t.samples[k] as RegionSample).clipped = true;
	t.clipped = ranges;
	return t.clipped;
}
