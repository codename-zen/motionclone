import { insideClip } from "./clip.ts";
import type { Hint, Sample } from "./types.ts";

export type StepPosition = "start" | "end";

export interface StepsFit {
	count: number;
	position: StepPosition;
	delayMs: number;
	durationMs: number;
	rmse: number;
}

/** CSS steps(n, position) progress at time fraction u. */
export function stepsY(n: number, position: StepPosition, u: number): number {
	if (u <= 0) return 0;
	if (u >= 1) return 1;
	return position === "end" ? Math.floor(n * u) / n : Math.ceil(n * u) / n;
}

const rmseOf = (
	samples: readonly Sample[],
	n: number,
	pos: StepPosition,
	delay: number,
	dur: number,
) => {
	let sum = 0;
	for (const [t, p] of samples)
		sum += (stepsY(n, pos, (t - delay) / dur) - p) ** 2;
	return Math.sqrt(sum / samples.length);
};

/** Grid search over count, position, delay and duration inside the hint's clip; plateaus make gradient methods useless here. */
export function fitSteps(
	samples: readonly Sample[],
	hint: Hint,
	maxCount = 32,
): StepsFit | null {
	const span = Math.max(hint.endMs - hint.startMs, hint.frameMs);
	let best: StepsFit | null = null;
	for (let n = 2; n <= maxCount; n++) {
		const lo = span * 0.95;
		const hi = span * (n / Math.max(n - 2, 1)) * 1.05 + 2 * hint.frameMs;
		for (const pos of ["end", "start"] as const) {
			for (let i = 0; i <= 60; i++) {
				const dur = lo + ((hi - lo) * i) / 60;
				const first = pos === "end" ? hint.startMs - dur / n : hint.startMs;
				for (let d = -1.5 * hint.frameMs; d <= 1.5 * hint.frameMs; d += 2) {
					const delay = first + d;
					if (!insideClip(hint, delay, dur)) continue;
					const r = rmseOf(samples, n, pos, delay, dur);
					// Fewer steps win ties: a finer staircase can also hit coarse plateaus.
					if (!best || r < best.rmse - 1e-4)
						best = {
							count: n,
							position: pos,
							delayMs: delay,
							durationMs: dur,
							rmse: r,
						};
				}
			}
		}
	}
	return best;
}
