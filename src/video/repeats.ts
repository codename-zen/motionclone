import type { RegionSample } from "./samples.ts";

// A frame repeats the one before it in a region when the region changes this much less into it than on either side,
// and the element stands still into it (frame pixels), while it moves on either side.
const REPEAT_SHARE = 0.1;
const STILL = 0.25;
// On either side the element moves at least this far a frame (frame pixels): clearly in motion, not settling.
const MOVES = 1;
// Both sides must change by at least this mean luma, levels: the element is moving through the frame.
const MOVING = 1;

const step = (a: RegionSample, b: RegionSample) => ({
	x: b.dx - a.dx,
	y: b.dy - a.dy,
});

/**
 * Mark frames that repeat the frame before them in a region while the element moves on in the same direction on
 * either side: a recording that held a frame, not a stall of the element (a turn, as in an overshoot, reverses).
 * Their readings are left out like a lost frame's, so a motion's samples keep their true times.
 */
export function markRepeats(smp: RegionSample[]): number[] {
	const out: number[] = [];
	for (let k = 2; k + 1 < smp.length; k++) {
		const [a, b, c, d] = [k - 2, k - 1, k, k + 1].map(
			(j) => smp[j] as RegionSample,
		) as [RegionSample, RegionSample, RegionSample, RegionSample];
		if (![a, b, c, d].every((p) => p.found)) continue;
		const side = Math.min(b.energy, d.energy);
		const before = step(a, b);
		const after = step(c, d);
		const onward =
			before.x * after.x + before.y * after.y > 0 &&
			Math.min(Math.hypot(before.x, before.y), Math.hypot(after.x, after.y)) >=
				MOVES;
		const held = step(b, c);
		const still = Math.hypot(held.x, held.y) <= STILL;
		if (onward && still && side >= MOVING && c.energy <= REPEAT_SHARE * side)
			out.push(k);
	}
	for (const k of out) (smp[k] as RegionSample).repeat = true;
	return out;
}
