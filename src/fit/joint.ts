import {
	type Candidate,
	evaluate,
	exact,
	finish,
	fitTimingOf,
	type JointFit,
	type PartialTrack,
	timingOf,
	visibleChange,
} from "./joint-timing.ts";
import { nelderMead } from "./optimize.ts";
import { OVERSHOOT_MIN, plausibleBezier, sanitizeBezier } from "./plausible.ts";
import { PRESETS } from "./presets.ts";
import type { Hint } from "./types.ts";

export {
	boundsRmse,
	type JointFit,
	outside,
	type PartialTrack,
	visibleChange,
} from "./joint-timing.ts";

// A free bezier must beat the named curve by this much rmse, plus the reading noise, to be kept.
const PRESET_WITHIN = 0.005;
// A track's best rms counts as at least this, so a near-exact track cannot outweigh the others alone.
const EVIDENCE_FLOOR = 0.005;
// Named curves refitted with evidence weights: the closest few, since the reweighting only reorders near ties.
const EVIDENCE_TOP = 4;

/** How far plain readings go past the end value, against the side the motion comes from, in visible-change units. */
function overshootSeen(
	tracks: readonly PartialTrack[],
	spans: readonly number[],
) {
	let over = 0;
	tracks.forEach((tr, i) => {
		const plain = tr.obs.filter(exact);
		const side = Math.sign((plain[0]?.lo ?? tr.to) - tr.to);
		for (const o of plain)
			over = Math.max(over, (side * (tr.to - o.lo)) / (spans[i] as number));
	});
	return { under: 0, over };
}

const weightedRmse = (tracks: readonly PartialTrack[], f: JointFit) => {
	let sum = 0;
	let w = 0;
	tracks.forEach((tr, i) => {
		sum += tr.weight * (f.rmse[i] as number) ** 2;
		w += tr.weight;
	});
	return Math.sqrt(sum / Math.max(w, 1e-9));
};

/**
 * Joint evidence: lead tracks reweighted by the best rms any named curve reaches on each, so a precise track (a
 * position) pins the curve and timing that a noisy one (an opacity proxy) cannot tell apart.
 * Returns the named curves refitted with those weights, best first.
 */
function byEvidence(
	tracks: readonly PartialTrack[],
	spans: readonly number[],
	named: readonly Candidate[],
	hints: readonly Hint[],
): { tracks: PartialTrack[]; named: Candidate[] } {
	if (tracks.filter((tr) => tr.weight > 0).length < 2)
		return { tracks: [...tracks], named: [...named] };
	const fits = named.map((c) => finish(tracks, spans, c));
	const weighted = tracks.map((tr, i) => {
		const best = Math.min(...fits.map((f) => f.rmse[i] as number));
		return { ...tr, weight: tr.weight / Math.max(EVIDENCE_FLOOR, best) ** 2 };
	});
	const score = (f: JointFit) =>
		weighted.reduce(
			(s, tr, i) => s + tr.weight * (f.rmse[i] as number) ** 2,
			0,
		);
	const refit = named
		.map((c, k) => ({ c, s: score(fits[k] as JointFit) }))
		.sort((a, b) => a.s - b.s)
		.slice(0, EVIDENCE_TOP)
		.map(({ c }) => fitTimingOf(weighted, spans, c.p, hints))
		.sort((a, b) => a.loss - b.loss);
	return { tracks: weighted, named: refit };
}

/**
 * One cubic-bezier and duration for tracks that move together, from readings that may be bounds; each group of
 * tracks has its own delay. Start values are fitted. The named curve is chosen by joint evidence (`byEvidence`); it
 * wins unless a free one is closer by more than `noise`, the rms error of a reading, because noise alone lets a
 * free curve bend towards it.
 */
export function fitJoint(
	tracks: readonly PartialTrack[],
	hints: readonly Hint[],
	noise = 0,
): JointFit {
	const spans = tracks.map((tr) => visibleChange(tr.obs, tr.to));
	const seen = overshootSeen(tracks, spans);
	const margin = OVERSHOOT_MIN + noise;
	const past = seen.over > margin;
	const sanitize = (x: readonly number[]) => sanitizeBezier(x, past);
	const { tracks: weighted, named: presets } = byEvidence(
		tracks,
		spans,
		PRESETS.filter((pr) => plausibleBezier(pr.p, seen, margin))
			.map((pr) => fitTimingOf(tracks, spans, pr.p, hints))
			.sort((a, b) => a.loss - b.loss),
		hints,
	);
	const frameMs = (hints[0] as Hint).frameMs;
	let free = presets[0] as Candidate;
	for (const pr of presets.slice(0, 4)) {
		const m = nelderMead(
			(x) => {
				const t = timingOf(x.slice(4));
				return evaluate(weighted, spans, sanitize(x), t.delays, t.durationMs)
					.loss;
			},
			[...pr.p, ...pr.x],
			[
				0.1,
				0.1,
				0.1,
				0.1,
				(pr.x[0] as number) * 0.05,
				...hints.map(() => frameMs),
			],
			{ maxIter: 800 },
		);
		const p = sanitize(m.x);
		if (m.fx < free.loss && plausibleBezier(p, seen, margin))
			free = { p, x: m.x.slice(4), loss: m.fx };
	}
	const named = finish(tracks, spans, presets[0] as Candidate);
	const curve = finish(tracks, spans, free);
	return weightedRmse(tracks, curve) + PRESET_WITHIN + noise <
		weightedRmse(tracks, named)
		? curve
		: named;
}
