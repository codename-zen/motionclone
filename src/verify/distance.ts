import type { SpecRow } from "../spec/schema.ts";
import type { CloneMotion } from "./clone.ts";
import { distanceMessage, unitOf } from "./messages.ts";
import type { Metric } from "./schema.ts";
import { metric } from "./timing.ts";

type Moving = Extract<CloneMotion, { status: "moving" }>;

export const LOWER_BOUND_VERIFY_NOTE =
	"the reference distance is a lower bound (its element was clipped at the region edge), so a longer move passes";

export const isScale = (p: string) =>
	p === "scale" || p === "scaleX" || p === "scaleY";

export const logRatio = (from: number, to: number) =>
	from > 0 && to > 0 ? Math.abs(Math.log(to / from)) : Math.abs(to - from);

/** Distance of the clone's move against the row's; null when the row has no distance to compare. */
export function distanceCheck(
	row: SpecRow,
	c: Moving,
): { metric: Metric; failure: string | null; note: string | null } | null {
	const w = c.motion.window;
	const relative = row.relativeDistance !== null && w.relative !== null;
	// A scale is compared as a ratio: 1 -> 1.6 and 0.624 -> 1 are the same growth seen from different ends.
	const ratio = isScale(row.property) && !relative;
	const wantDist = ratio
		? logRatio(row.from, row.to)
		: relative
			? (row.relativeDistance as number)
			: Math.abs(row.to - row.from);
	const gotDist = ratio
		? logRatio(w.from, w.to)
		: relative
			? (w.relative as number)
			: Math.abs(w.change);
	if (wantDist <= 0) return null;
	const tol = row.tolerances.distance;
	const m = metric(
		wantDist,
		gotDist,
		gotDist / wantDist - 1,
		tol,
		relative ? "of size" : unitOf(row.property).trim(),
	);
	const lowerBound = row.distanceObserved === "lower-bound";
	if (lowerBound) m.pass = (m.diff as number) >= -tol;
	return {
		metric: m,
		failure: m.pass ? null : distanceMessage(row, c, m),
		note: lowerBound ? LOWER_BOUND_VERIFY_NOTE : null,
	};
}
