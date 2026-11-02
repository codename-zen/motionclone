import { bezierY } from "./bezier.ts";
import { nelderMead } from "./optimize.ts";
import { OVERSHOOT_MIN, plausibleBezier, sanitizeBezier } from "./plausible.ts";
import { type BezierParams, PRESETS } from "./presets.ts";
import type { Hint, Observation } from "./types.ts";

/** One property of an element, in its own units. */
export interface PartialTrack {
	obs: Observation[];
	to: number;
	/** 1 lets the track set the shared timing; 0 only fits its start value to it. */
	weight: number;
	/** Index of the delay this track uses; tracks of one element share one, staggered siblings have their own. */
	group: number;
	/** Bounds for the fitted start value, such as [0, 1] for opacity. */
	range?: readonly [number, number];
}

export interface JointFit {
	/** Delay per group. */
	delays: number[];
	durationMs: number;
	p: BezierParams;
	/** Start value per track, fitted from its plain readings within the track's range. */
	froms: number[];
	/** Start value per track the plain readings alone point to, before the range applies. */
	wanted: number[];
	/** Root mean square distance from each track's readings to the curve, in units of its visible change. */
	rmse: number[];
	/** Largest such distance per track, with its time. */
	max: { value: number; atMs: number }[];
}

// Residuals beyond this many progress units count linearly, so one bad frame cannot pull the curve.
const HUBER = 0.03;
// A free bezier must beat the named curve by this much rmse, plus the reading noise, to be kept.
const PRESET_WITHIN = 0.005;
const DUR_SCALES = [0.8, 1, 1.3, 1.7, 2.2, 3];

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));
const exact = (o: Observation) => o.lo === o.hi;
const huber = (r: number) => (r <= HUBER ? r * r : HUBER * (2 * r - HUBER));
const rms = (r: readonly number[]) =>
	Math.sqrt(r.reduce((a, b) => a + b * b, 0) / Math.max(1, r.length));

/** How far a value lies outside a reading's bounds. */
export const outside = (v: number, o: Observation) =>
	v < o.lo ? o.lo - v : v > o.hi ? v - o.hi : 0;

/** The change the plain readings show against the end value: the unit residuals are measured in. */
export function visibleChange(obs: readonly Observation[], to: number): number {
	const far = Math.max(0, ...obs.filter(exact).map((o) => Math.abs(o.lo - to)));
	return far > 0 ? far : 1;
}

/** Root mean square of how far `predict` falls outside the readings, in units of `span`. */
export function boundsRmse(
	obs: readonly Observation[],
	predict: (t: number) => number,
	span: number,
): number {
	return rms(obs.map((o) => outside(predict(o.t), o) / span));
}

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

interface Evaluated {
	froms: number[];
	wanted: number[];
	residuals: number[][];
	loss: number;
}

function evaluate(
	tracks: readonly PartialTrack[],
	spans: readonly number[],
	p: BezierParams,
	delays: readonly number[],
	durationMs: number,
): Evaluated {
	const froms: number[] = [];
	const wanted: number[] = [];
	const residuals: number[][] = [];
	let sum = 0;
	let weights = 0;
	tracks.forEach((tr, i) => {
		const delay = delays[tr.group] as number;
		const rest = tr.obs.map((o) => 1 - bezierY(p, (o.t - delay) / durationMs));
		// The start value is linear in the model, so least squares on the plain readings gives it directly.
		let num = 0;
		let den = 0;
		tr.obs.forEach((o, k) => {
			if (!exact(o)) return;
			const r = rest[k] as number;
			num += (o.lo - tr.to) * r;
			den += r * r;
		});
		const free = den > 1e-9 ? tr.to + num / den : tr.to;
		// The loss is quadratic in the start value, so clamping the free solution gives the bounded optimum.
		const from = tr.range ? clamp(free, tr.range[0], tr.range[1]) : free;
		const span = spans[i] as number;
		const r = tr.obs.map(
			(o, k) => outside(tr.to + (from - tr.to) * (rest[k] as number), o) / span,
		);
		froms.push(from);
		wanted.push(free);
		residuals.push(r);
		if (tr.weight > 0 && r.length > 0) {
			sum += (tr.weight * r.reduce((a, b) => a + huber(b), 0)) / r.length;
			weights += tr.weight;
		}
	});
	return { froms, wanted, residuals, loss: weights > 0 ? sum / weights : 0 };
}

interface Candidate {
	p: BezierParams;
	/** Duration, then one delay per group. */
	x: number[];
	loss: number;
}

const timingOf = (x: readonly number[]) => ({
	durationMs: Math.max(1, x[0] as number),
	delays: x.slice(1),
});

function fitTimingOf(
	tracks: readonly PartialTrack[],
	spans: readonly number[],
	p: BezierParams,
	hints: readonly Hint[],
): Candidate {
	const frameMs = (hints[0] as Hint).frameMs;
	const base = Math.max(4 * frameMs, ...hints.map((h) => h.endMs - h.startMs));
	const f = (x: readonly number[]) => {
		const t = timingOf(x);
		return evaluate(tracks, spans, p, t.delays, t.durationMs).loss;
	};
	const seeds: number[][] = [];
	for (const back of [0.5, 2, 4])
		for (const k of DUR_SCALES)
			seeds.push([base * k, ...hints.map((h) => h.startMs - back * frameMs)]);
	const top = seeds
		.map((s) => ({ s, l: f(s) }))
		.sort((a, b) => a.l - b.l)
		.slice(0, 3);
	let best: Candidate = {
		p,
		x: top[0]?.s ?? [base],
		loss: Number.POSITIVE_INFINITY,
	};
	for (const { s } of top) {
		const m = nelderMead(f, s, [
			(s[0] as number) * 0.1,
			...hints.map(() => frameMs),
		]);
		if (m.fx < best.loss) best = { p, x: m.x, loss: m.fx };
	}
	return best;
}

function finish(
	tracks: readonly PartialTrack[],
	spans: readonly number[],
	c: Candidate,
): JointFit {
	const t = timingOf(c.x);
	const e = evaluate(tracks, spans, c.p, t.delays, t.durationMs);
	return {
		...t,
		p: c.p,
		froms: e.froms,
		wanted: e.wanted,
		rmse: e.residuals.map(rms),
		max: e.residuals.map((r, i) => {
			let at = 0;
			r.forEach((v, k) => {
				if (v > (r[at] as number)) at = k;
			});
			return { value: r[at] ?? 0, atMs: tracks[i]?.obs[at]?.t ?? 0 };
		}),
	};
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
 * One cubic-bezier and duration for tracks that move together, from readings that may be bounds; each group of
 * tracks has its own delay. Start values are fitted. A named curve wins unless a free one is closer by more than
 * `noise`, the rms error of a reading, because noise alone lets a free curve bend towards it.
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
	const presets = PRESETS.filter((pr) => plausibleBezier(pr.p, seen, margin))
		.map((pr) => fitTimingOf(tracks, spans, pr.p, hints))
		.sort((a, b) => a.loss - b.loss);
	const frameMs = (hints[0] as Hint).frameMs;
	let free = presets[0] as Candidate;
	for (const pr of presets.slice(0, 4)) {
		const m = nelderMead(
			(x) => {
				const t = timingOf(x.slice(4));
				return evaluate(tracks, spans, sanitize(x), t.delays, t.durationMs)
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
