import { clampTiming } from "./clip.ts";
import { nelderMead } from "./optimize.ts";
import type { Hint, Sample } from "./types.ts";

export interface Spring {
	stiffness: number;
	damping: number;
	mass: number;
}

export const dampingRatio = (s: Spring): number =>
	s.damping / (2 * Math.sqrt(s.stiffness * s.mass));

/** Unit step response of a damped oscillator from 0 to 1 at rest, tSec seconds after release. */
export function springResponse(s: Spring, tSec: number): number {
	if (tSec <= 0) return 0;
	const w0 = Math.sqrt(s.stiffness / s.mass);
	const z = dampingRatio(s);
	if (Math.abs(z - 1) < 1e-6) return 1 - Math.exp(-w0 * tSec) * (1 + w0 * tSec);
	if (z < 1) {
		const a = z * w0;
		const wd = w0 * Math.sqrt(1 - z * z);
		return (
			1 -
			Math.exp(-a * tSec) *
				(Math.cos(wd * tSec) + (a / wd) * Math.sin(wd * tSec))
		);
	}
	const r = w0 * Math.sqrt(z * z - 1);
	const s1 = -z * w0 + r;
	const s2 = -z * w0 - r;
	return 1 - (s2 * Math.exp(s1 * tSec) - s1 * Math.exp(s2 * tSec)) / (s2 - s1);
}

/** Last time (ms) the response is outside the band around 1. */
export function settleMs(s: Spring, band = 0.02): number {
	let last = 0;
	for (let ms = 1; ms <= 60_000; ms++)
		if (Math.abs(springResponse(s, ms / 1000) - 1) > band) last = ms;
	return last;
}

export interface SpringFit extends Spring {
	zeta: number;
	omega0: number;
	delayMs: number;
	/** 2% band settle time measured from the delay. */
	settleMs: number;
	rmse: number;
}

const fromLog = (lnW: number, lnZ: number): Spring => {
	const w0 = Math.exp(lnW);
	return { stiffness: w0 * w0, damping: 2 * Math.exp(lnZ) * w0, mass: 1 };
};

function rmseOf(
	samples: readonly Sample[],
	s: Spring,
	delayMs: number,
): number {
	let sum = 0;
	for (const [t, p] of samples)
		sum += (springResponse(s, (t - delayMs) / 1000) - p) ** 2;
	return Math.sqrt(sum / samples.length);
}

/** Fit stiffness and damping (mass 1) plus delay, seeded from overshoot and settle time. */
export function fitSpring(samples: readonly Sample[], hint: Hint): SpringFit {
	const delay0 = hint.startMs - hint.frameMs / 2;
	const settleSec = Math.max(
		(hint.endMs - hint.startMs) / 1000,
		(2 * hint.frameMs) / 1000,
	);
	let peak = samples[0] as Sample;
	for (const s of samples) if (s[1] > peak[1]) peak = s;
	const seeds: [number, number][] = [];
	const os = peak[1] - 1;
	if (os > 0.001) {
		const l = Math.log(os);
		const z = -l / Math.sqrt(Math.PI ** 2 + l * l);
		const tp = Math.max((peak[0] - delay0) / 1000, 0.01);
		seeds.push([Math.log(Math.PI / tp / Math.sqrt(1 - z * z)), Math.log(z)]);
	}
	// The window ends at the 1% band, so ln(100) / (zeta * w0) is about the settle time.
	for (const z of [0.3, 0.6, 1, 2])
		seeds.push([Math.log(Math.log(100) / (z * settleSec)), Math.log(z)]);
	const delayOf = (d: number) => clampTiming(hint, d, 1).delayMs;
	let best: { x: number[]; fx: number } | null = null;
	for (const [lw, lz] of seeds) {
		const m = nelderMead(
			(x) =>
				rmseOf(
					samples,
					fromLog(x[0] as number, x[1] as number),
					delayOf(x[2] as number),
				),
			[lw, lz, delay0],
			[0.2, 0.2, hint.frameMs / 2],
			{ maxIter: 600 },
		);
		if (!best || m.fx < best.fx) best = m;
	}
	const b = best as { x: number[]; fx: number };
	const spring = fromLog(b.x[0] as number, b.x[1] as number);
	return {
		...spring,
		zeta: dampingRatio(spring),
		omega0: Math.sqrt(spring.stiffness),
		delayMs: delayOf(b.x[2] as number),
		settleMs: settleMs(spring),
		rmse: b.fx,
	};
}

export interface CssLinear {
	css: string;
	/** Duration the string assumes: the time the spring is within 0.5% of rest. */
	durationMs: number;
	stops: number;
}

/** Spring as a CSS linear() easing sampled evenly over its settle time. */
export function toCssLinear(spring: Spring, stops?: number): CssLinear {
	const durationMs = Math.max(settleMs(spring, 0.005), 1);
	const at = (i: number, n: number) =>
		springResponse(spring, (durationMs * i) / n / 1000);
	const maxErr = (n: number) => {
		let worst = 0;
		for (let k = 0; k <= 1000; k++) {
			const x = (k / 1000) * n;
			const i = Math.min(Math.floor(x), n - 1);
			const v = at(i, n) + (at(i + 1, n) - at(i, n)) * (x - i);
			worst = Math.max(worst, Math.abs(v - at(k, 1000)));
		}
		return worst;
	};
	let n = stops ? stops - 1 : Math.max(10, Math.ceil(durationMs / 20));
	if (!stops) while (maxErr(n) > 0.005 && n < 200) n = Math.ceil(n * 1.5);
	const values = Array.from({ length: n + 1 }, (_, i) =>
		i === n ? 1 : Number(at(i, n).toFixed(4)),
	);
	return { css: `linear(${values.join(", ")})`, durationMs, stops: n + 1 };
}
