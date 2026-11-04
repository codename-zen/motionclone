import type { Series } from "../measure/series.ts";
import type { MotionWindow } from "../measure/window.ts";
import { bezierY, fitBezier, fitPreset, fitTiming } from "./bezier.ts";
import { pinned } from "./clip.ts";
import {
	excursion,
	MIN_FRAMES,
	OVERSHOOT_MIN,
	plausibleBezier,
	seriesBounds,
	type TimeBounds,
	timingProblem,
} from "./plausible.ts";
import type { BezierParams } from "./presets.ts";
import { PRESETS } from "./presets.ts";
import { dampingRatio, fitSpring, type Spring } from "./spring.ts";
import { fitSteps, type StepPosition } from "./steps.ts";
import type { Hint, Sample } from "./types.ts";

interface Base {
	rmse: number;
	delayMs: number;
	durationMs: number;
	/** Whether the curve goes past its end value. */
	overshoots: boolean;
}

export type Candidate = Base &
	(
		| { kind: "linear" }
		| { kind: "preset"; name: string; aliases: string[]; p: BezierParams }
		| { kind: "bezier"; p: BezierParams }
		| { kind: "spring"; spring: Spring; zeta: number }
		| { kind: "steps"; count: number; position: StepPosition }
	);

export interface Classification {
	best: Candidate;
	candidates: Candidate[];
	/** Largest excursion past the end value, as a fraction of the change. */
	overshoot: number;
}

export const SIMPLER_WITHIN = 0.005;
export { OVERSHOOT_MIN };

// Progress this far from both ends is mid-motion, where a repeated value is a repeated frame, not a rest.
const MID = 0.002;

// Mid-motion repeats this many times or more mark a recording that repeats frames.
const REPEATED = 2;

/**
 * A recording encoded above its own frame rate repeats frames: mid-motion, a run of equal readings is one reading at
 * the run's first time, so the repeats do not stretch or shift the curve. Runs of three or more are steps or holds
 * and stay. In such a recording the last start value
 * before the motion may repeat a frame too, so it is left out as well.
 */
export function dropRepeats(samples: readonly Sample[]): Sample[] {
	const p = (i: number) => (samples[i] as Sample)[1];
	const repeat = (i: number) => i > 0 && p(i) === p(i - 1);
	const mid = (i: number) => p(i) > MID && p(i) < 1 - MID;
	const repeats = samples.filter((_, i) => repeat(i) && mid(i)).length;
	// A value held three frames or more mid-motion is a step or a hold, not a repeated frame.
	const held = samples.some((_, i) => repeat(i) && repeat(i - 1) && mid(i));
	if (repeats < REPEATED || held) return [...samples];
	return samples.filter(
		(_, i) =>
			!repeat(i) ||
			(!mid(i) && !(p(i) <= MID && i + 1 < samples.length && p(i + 1) > MID)),
	);
}

/** Window samples as progress 0..1, from just before the start to well past the visible end; repeated frames dropped. */
export function normalise(
	series: Series,
	w: MotionWindow,
): { samples: Sample[]; hint: Hint } {
	const gaps = series.slice(1).map((p, i) => p[0] - (series[i]?.[0] ?? 0));
	const frameMs = [...gaps].sort((a, b) => a - b)[gaps.length >> 1] ?? 16.7;
	const t0 = w.startMs - 3 * frameMs;
	const t1 = w.endMs + (w.endMs - w.startMs) + 5 * frameMs;
	// There-and-back moves can end exactly where they started, so they are scaled by their peak instead.
	const span = w.thereAndBack ? w.peak - w.from : w.change;
	const samples = dropRepeats(
		series
			.filter(([t]) => t >= t0 && t <= t1)
			.map(([t, v]): Sample => [t, (v - w.from) / span]),
	);
	return { samples, hint: { startMs: w.startMs, endMs: w.endMs, frameMs } };
}

/** `normalise` with the hint held to `bounds`, by default the series' own span. */
export function normaliseIn(
	series: Series,
	w: MotionWindow,
	bounds?: TimeBounds,
): { samples: Sample[]; hint: Hint; clip: TimeBounds } {
	const { samples, hint } = normalise(series, w);
	const clip = bounds ?? seriesBounds(series, hint.frameMs);
	return {
		samples,
		hint: { ...hint, clip: { firstMs: clip.firstMs, lastMs: clip.lastMs } },
		clip,
	};
}

const maxY = (p: BezierParams) => {
	let m = 0;
	for (let i = 1; i < 200; i++) m = Math.max(m, bezierY(p, i / 200));
	return m;
};

/** Steps and linear always fit; curves need two frames and may not overshoot more than the samples do. */
function plausible(
	c: Candidate,
	seen: ReturnType<typeof excursion>,
	frameMs: number,
): boolean {
	if (c.kind === "linear" || c.kind === "steps") return true;
	if (c.durationMs < MIN_FRAMES * frameMs) return false;
	if (c.kind === "spring") {
		const over =
			c.zeta < 1
				? Math.exp((-Math.PI * c.zeta) / Math.sqrt(1 - c.zeta ** 2))
				: 0;
		return over <= seen.over + OVERSHOOT_MIN;
	}
	return plausibleBezier(c.p, seen, OVERSHOOT_MIN);
}

// Lower is simpler; a spring that must explain overshoot beats a free bezier.
const complexity = (c: Candidate, overshooting: boolean): number => {
	switch (c.kind) {
		case "linear":
			return 0;
		case "preset":
			return 1;
		case "steps":
			return 2;
		case "bezier":
			return overshooting ? 4 : 3;
		case "spring":
			return overshooting ? 3 : 4;
	}
};

/** Fit every curve kind; the simplest close fit wins among those whose timing lies in `bounds` (default: the series' span). */
export function classifyMotion(
	series: Series,
	window: MotionWindow,
	bounds?: TimeBounds,
): Classification {
	const { samples, hint, clip } = normaliseIn(series, window, bounds);
	const overshoot = Math.max(0, ...samples.map((s) => s[1] - 1));
	const seen = excursion(samples);
	const candidates: Candidate[] = [];

	const lin = fitTiming(samples, hint, (u) => u);
	candidates.push({ kind: "linear", ...lin, overshoots: false });

	let nearest = fitPreset(
		samples,
		hint,
		PRESETS[0] as (typeof PRESETS)[number],
	);
	let nearestP = (PRESETS[0] as (typeof PRESETS)[number]).p;
	for (const pr of PRESETS.slice(1)) {
		if (!plausibleBezier(pr.p, seen, OVERSHOOT_MIN)) continue;
		const f = fitPreset(samples, hint, pr);
		if (f.rmse < nearest.rmse) {
			nearest = f;
			nearestP = pr.p;
		}
	}
	candidates.push({
		kind: "preset",
		name: nearest.name,
		aliases: nearest.aliases,
		p: nearestP,
		rmse: nearest.rmse,
		delayMs: nearest.delayMs,
		durationMs: nearest.durationMs,
		overshoots: maxY(nearestP) > 1.01,
	});

	const bez = fitBezier(samples, hint);
	candidates.push({
		kind: "bezier",
		p: bez.p,
		rmse: bez.rmse,
		delayMs: bez.delayMs,
		durationMs: bez.durationMs,
		overshoots: maxY(bez.p) > 1.01,
	});

	const sp = fitSpring(samples, hint);
	const spring: Spring = {
		stiffness: sp.stiffness,
		damping: sp.damping,
		mass: sp.mass,
	};
	candidates.push({
		kind: "spring",
		spring,
		zeta: dampingRatio(spring),
		rmse: sp.rmse,
		delayMs: sp.delayMs,
		durationMs: sp.settleMs,
		overshoots:
			dampingRatio(spring) < 1 &&
			Math.exp((-Math.PI * sp.zeta) / Math.sqrt(1 - sp.zeta ** 2)) > 0.01,
	});

	const st = fitSteps(samples, hint);
	if (st)
		candidates.push({
			kind: "steps",
			count: st.count,
			position: st.position,
			rmse: st.rmse,
			delayMs: st.delayMs,
			durationMs: st.durationMs,
			overshoots: false,
		});

	candidates.sort((a, b) => a.rmse - b.rmse);
	const shaped = candidates.filter((c) => plausible(c, seen, hint.frameMs));
	// A fit that runs off the clip or rests on its limits, such as a plateau read as a curve of near-infinite
	// duration, yields to the next.
	const timed = shaped.filter(
		(c) =>
			timingProblem(c.delayMs, c.durationMs, clip) === null &&
			!pinned(hint, c.delayMs, c.durationMs),
	);
	const sane = timed.length > 0 ? timed : shaped;
	const needsOvershoot = overshoot > OVERSHOOT_MIN;
	const eligible = needsOvershoot ? sane.filter((c) => c.overshoots) : sane;
	const pool = eligible.length > 0 ? eligible : sane;
	const floor = (pool[0] as Candidate).rmse + SIMPLER_WITHIN;
	const best = pool
		.filter((c) => c.rmse <= floor)
		.sort(
			(a, b) =>
				complexity(a, needsOvershoot) - complexity(b, needsOvershoot) ||
				a.rmse - b.rmse,
		)[0] as Candidate;
	return { best, candidates, overshoot };
}
