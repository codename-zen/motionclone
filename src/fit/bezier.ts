import { nelderMead } from "./optimize.ts";
import { excursion, goesPast, sanitizeBezier } from "./plausible.ts";
import { type BezierParams, PRESETS, type Preset } from "./presets.ts";
import type { Hint, Sample } from "./types.ts";

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));

/** CSS cubic-bezier(x1,y1,x2,y2) progress at time fraction x. */
export function bezierY(p: BezierParams, x: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const [x1, y1, x2, y2] = p;
	const mix = (a: number, b: number, s: number) =>
		3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3;
	let s = x;
	for (let i = 0; i < 8; i++) {
		const err = mix(x1, x2, s) - x;
		if (Math.abs(err) < 1e-9) return mix(y1, y2, s);
		const d =
			3 * (1 - s) ** 2 * x1 +
			6 * (1 - s) * s * (x2 - x1) +
			3 * s * s * (1 - x2);
		if (Math.abs(d) < 1e-6) break;
		s -= err / d;
	}
	let lo = 0;
	let hi = 1;
	s = x;
	for (let i = 0; i < 50; i++) {
		if (mix(x1, x2, s) < x) lo = s;
		else hi = s;
		s = (lo + hi) / 2;
	}
	return mix(y1, y2, s);
}

export interface Timing {
	delayMs: number;
	durationMs: number;
}

export interface TimedFit extends Timing {
	rmse: number;
}

export interface NamedFit extends TimedFit {
	name: string;
	aliases: string[];
}

export interface BezierFit extends TimedFit {
	p: BezierParams;
	/** Closest named easing with its own rmse and timing. */
	preset: NamedFit;
}

/** rmse of a unit curve placed at delay with duration against the samples. */
export function curveRmse(
	samples: readonly Sample[],
	curve: (u: number) => number,
	delayMs: number,
	durationMs: number,
): number {
	let sum = 0;
	for (const [t, p] of samples) {
		const u = clamp((t - delayMs) / durationMs, 0, 1);
		sum += (curve(u) - p) ** 2;
	}
	return Math.sqrt(sum / samples.length);
}

const DUR_SCALES = [0.9, 1, 1.15, 1.3, 1.5, 1.8, 2.2, 3];

/** Best delay and duration for a fixed unit curve; the tail may hide beyond the visible window. */
export function fitTiming(
	samples: readonly Sample[],
	hint: Hint,
	curve: (u: number) => number,
): TimedFit {
	const base = Math.max(hint.endMs - hint.startMs, 2 * hint.frameMs);
	const seeds: Timing[] = [];
	for (const d of [hint.startMs - hint.frameMs / 2, hint.startMs - 0.15 * base])
		for (const k of DUR_SCALES)
			seeds.push({ delayMs: d, durationMs: base * k });
	const scored = seeds
		.map((s) => ({ s, r: curveRmse(samples, curve, s.delayMs, s.durationMs) }))
		.sort((a, b) => a.r - b.r)
		.slice(0, 3);
	let best: TimedFit = {
		delayMs: 0,
		durationMs: base,
		rmse: Number.POSITIVE_INFINITY,
	};
	for (const { s } of scored) {
		const m = nelderMead(
			(x) =>
				curveRmse(samples, curve, x[0] as number, Math.max(1, x[1] as number)),
			[s.delayMs, s.durationMs],
			[hint.frameMs / 2, s.durationMs * 0.05],
		);
		if (m.fx < best.rmse)
			best = {
				delayMs: m.x[0] as number,
				durationMs: Math.max(1, m.x[1] as number),
				rmse: m.fx,
			};
	}
	return best;
}

const curveOf = (p: BezierParams) => (u: number) => bezierY(p, u);

export function fitPreset(
	samples: readonly Sample[],
	hint: Hint,
	preset: Preset,
): NamedFit {
	return {
		name: preset.name,
		aliases: preset.aliases ?? [],
		...fitTiming(samples, hint, curveOf(preset.p)),
	};
}

/** Least-squares cubic-bezier with delay and duration fitted jointly; control points as `sanitizeBezier` allows. */
export function fitBezier(samples: readonly Sample[], hint: Hint): BezierFit {
	const past = goesPast(excursion(samples));
	const sanitize = (x: readonly number[]) => sanitizeBezier(x, past);
	const presetFits = PRESETS.map((pr) => ({
		pr,
		fit: fitPreset(samples, hint, pr),
	})).sort((a, b) => a.fit.rmse - b.fit.rmse);
	const nearest = presetFits[0] as (typeof presetFits)[number];
	let best: BezierFit = {
		p: nearest.pr.p,
		delayMs: nearest.fit.delayMs,
		durationMs: nearest.fit.durationMs,
		rmse: nearest.fit.rmse,
		preset: nearest.fit,
	};
	for (const { pr, fit } of presetFits.slice(0, 4)) {
		const m = nelderMead(
			(x) =>
				curveRmse(
					samples,
					curveOf(sanitize(x)),
					x[4] as number,
					Math.max(1, x[5] as number),
				),
			[...pr.p, fit.delayMs, fit.durationMs],
			[0.1, 0.1, 0.1, 0.1, hint.frameMs / 2, fit.durationMs * 0.05],
			{ maxIter: 800 },
		);
		if (m.fx < best.rmse)
			best = {
				...best,
				p: sanitize(m.x),
				delayMs: m.x[4] as number,
				durationMs: Math.max(1, m.x[5] as number),
				rmse: m.fx,
			};
	}
	return best;
}
