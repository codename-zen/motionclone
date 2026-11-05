import type { Plans } from "./plan.ts";
import { restPlan } from "./plan.ts";
import { restPlateaus, type Scan, sameState } from "./scan.ts";
import type { Anchor, TrackRegionInput } from "./state.ts";
import { findTravel, type Travel } from "./travel.ts";

// Distinct rest states compared pairwise, at most; the clip's earliest ones come first.
const MAX_STATES = 8;

/**
 * Plans for a region drawn over an element's whole travel (ADR 0002): of the rest states the region shows, the
 * pair between which content travels furthest and stays inside the region at both. That content is the element,
 * tracked as a rigid move. Null when no rigid content travels between any two rest states.
 */
export async function travelPlans(
	r: TrackRegionInput,
	scan: Scan,
	anchorAt: (k: number) => Promise<Anchor>,
	floor: number,
): Promise<Plans | null> {
	const states: number[] = [];
	for (const p of restPlateaus(scan, r, floor))
		if (
			states.length < MAX_STATES &&
			states.every((k) => !sameState(scan, k, p.k, r, floor))
		)
			states.push(p.k);
	let best: { a: Anchor; b: Anchor; t: Travel; d: number } | null = null;
	for (let i = 0; i < states.length; i++)
		for (let j = i + 1; j < states.length; j++) {
			const a = await anchorAt(states[i] as number);
			const b = await anchorAt(states[j] as number);
			const t = findTravel(a.frame, b.frame, r, floor, true);
			if (!t || t.leaves) continue;
			const d = Math.hypot(t.dx, t.dy);
			if (!best || d > best.d) best = { a, b, t, d };
		}
	if (!best) return null;
	const [main, other] = restPlan(r, best.a, best.b, scan.frames, floor, best.t);
	return { main, other };
}
