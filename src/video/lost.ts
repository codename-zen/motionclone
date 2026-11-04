import { overreach, TOUCH } from "./clip.ts";
import type { Rect } from "./match.ts";
import { type RegionSample, type RegionTrack, sampleBox } from "./samples.ts";
import { movesBetween, type Scan } from "./scan.ts";

// Shorter gaps are filled by interpolation without losing a move.
const MIN_LOST = 3;
// An element found this many pixels away on either side of a gap moved while it was lost.
const MOVED = 2;

/**
 * Runs of frames where the element was not found while the region changed, so a move there is not measured.
 * A region that bounds its element (a rigid element visible at both anchors) reports every such run; other
 * regions report gaps between found frames where the element came back elsewhere and stayed inside the region on
 * both sides, because their element may simply be covered, not there yet, or gone past the region edge.
 * Clipped frames are reported on their own and left out. Returns the ranges, also kept on the track.
 */
export function markLost(
	t: RegionTrack,
	scan: Scan,
	region: Rect,
	frame: Rect,
	floor: number,
	bounded: boolean,
): { from: number; to: number }[] {
	const smp = t.samples;
	const n = smp.length;
	const out: { from: number; to: number }[] = [];
	t.lost = out;
	// A region that never found its element is reported as such.
	if (!smp.some((p) => p.found)) return out;
	for (let k = 0; k < n; k++) {
		if (smp[k]?.found || smp[k]?.clipped) continue;
		let to = k;
		while (to + 1 < n && !smp[to + 1]?.found && !smp[to + 1]?.clipped) to++;
		const a = smp[k - 1];
		const b = smp[to + 1];
		const within = (p: RegionSample | undefined) =>
			p?.found === true &&
			overreach(sampleBox(t.box, p), region, frame) < -TOUCH;
		const moved =
			within(a) &&
			within(b) &&
			Math.hypot(
				(b as RegionSample).dx - (a as RegionSample).dx,
				(b as RegionSample).dy - (a as RegionSample).dy,
			) > MOVED;
		if (
			to - k + 1 >= MIN_LOST &&
			(bounded || moved) &&
			movesBetween(
				scan,
				Math.max(0, k - 1),
				Math.min(n - 1, to + 1),
				region,
				floor,
			)
		)
			out.push({ from: k, to });
		k = to;
	}
	return out;
}
