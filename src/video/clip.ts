import type { Rect } from "./match.ts";
import { type RegionSample, type RegionTrack, sampleBox } from "./samples.ts";

// A box edge within this many pixels of the region edge touches it.
const TOUCH = 1;
// The box centre moves more than this many pixels from the neighbouring frame: the element is still moving.
const MOVING = 0.5;

/**
 * How far the box reaches past the region on its worst side; negative while it stays inside. Sides where the
 * region ends at the frame edge do not count: there the frame cuts the content, not the region.
 */
function overreach(b: Rect, r: Rect, frame: Rect): number {
	const none = Number.NEGATIVE_INFINITY;
	return Math.max(
		r.x > frame.x ? r.x - b.x : none,
		r.y > frame.y ? r.y - b.y : none,
		r.x + r.w < frame.x + frame.w ? b.x + b.w - (r.x + r.w) : none,
		r.y + r.h < frame.y + frame.h ? b.y + b.h - (r.y + r.h) : none,
	);
}

const centre = (t: RegionTrack, p: RegionSample) => ({
	x: t.box.x + t.box.w / 2 + p.dx,
	y: t.box.y + t.box.h / 2 + p.dy,
});

function moving(t: RegionTrack, k: number): boolean {
	const p = t.samples[k] as RegionSample;
	return [k - 1, k + 1].some((j) => {
		const q = t.samples[j];
		if (!q?.found) return false;
		const a = centre(t, p);
		const b = centre(t, q);
		return Math.hypot(a.x - b.x, a.y - b.y) > MOVING;
	});
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
		const over = overreach(sampleBox(t.box, p), region, frame);
		if (!(over > TOUCH || (over > -TOUCH && moving(t, k)))) return;
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
