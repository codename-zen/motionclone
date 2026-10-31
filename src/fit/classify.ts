import type { Series } from "../measure/series.ts";
import type { MotionWindow } from "../measure/window.ts";
import { bezierY, fitBezier, fitPreset, fitTiming } from "./bezier.ts";
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
export const OVERSHOOT_MIN = 0.02;

/** Window samples as progress 0..1, from just before the start to well past the visible end. */
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
	const samples = series
		.filter(([t]) => t >= t0 && t <= t1)
		.map(([t, v]): Sample => [t, (v - w.from) / span]);
	return { samples, hint: { startMs: w.startMs, endMs: w.endMs, frameMs } };
}

const maxY = (p: BezierParams) => {
	let m = 0;
	for (let i = 1; i < 200; i++) m = Math.max(m, bezierY(p, i / 200));
	return m;
};

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

export function classifyMotion(
	series: Series,
	window: MotionWindow,
): Classification {
	const { samples, hint } = normalise(series, window);
	const overshoot = Math.max(0, ...samples.map((s) => s[1] - 1));
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
	const needsOvershoot = overshoot > OVERSHOOT_MIN;
	const eligible = needsOvershoot
		? candidates.filter((c) => c.overshoots)
		: candidates;
	const pool = eligible.length > 0 ? eligible : candidates;
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
