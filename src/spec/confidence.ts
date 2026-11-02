import type { Observation } from "../fit/types.ts";
import type { SpecRow } from "./schema.ts";

type Level = SpecRow["confidence"];
export type Support = NonNullable<SpecRow["support"]>;

// A reading below this tracker quality is not counted as a sample.
const RELIABLE_QUALITY = 0.5;
const LEVELS: Level[] = ["low", "medium", "high"];

const levelOf = (value: number, high: number, medium: number, up = true) =>
	(up ? value >= high : value <= high)
		? "high"
		: (up ? value >= medium : value <= medium)
			? "medium"
			: "low";

const round = (v: number, d = 3) => Number(v.toFixed(d));

export interface SupportInput {
	obs: readonly Observation[];
	startMs: number;
	durationMs: number;
	/** Fit error in units of the change (the visible change for partly observed rows). */
	rmse: number;
	/** Share of the change the readings show: 1 when the start value is seen. */
	observed: number;
	/** Typical error of a plain reading, as in the observation model; 0 for page captures. */
	noise: number;
	/** Reasons found while fitting that make the row weak on their own, such as a capped start value. */
	weak?: string[];
}

/**
 * Confidence is the lowest of four levels (ADR 0003):
 * reliable samples in the motion (6 high, 3 medium), fit rms (0.005 + noise / 2 high, 0.02 + noise medium),
 * share of the change observed (0.9 high, 0.5 medium) and mean tracker quality when reported (0.8 high, 0.5 medium).
 */
export function supportOf(e: SupportInput): {
	confidence: Level;
	support: Support;
} {
	const end = e.startMs + e.durationMs;
	const inMotion = e.obs.filter((o) => o.t >= e.startMs && o.t <= end);
	const samples = inMotion.filter(
		(o) => o.lo === o.hi && !o.filled && (o.q ?? 1) >= RELIABLE_QUALITY,
	).length;
	const rated = inMotion.filter((o) => typeof o.q === "number");
	const quality = rated.length
		? rated.reduce((a, o) => a + (o.q as number), 0) / rated.length
		: null;
	const checks: [Level, string][] = [
		[
			levelOf(samples, 6, 3),
			`${samples} reliable sample${samples === 1 ? "" : "s"} in the motion`,
		],
		[
			levelOf(e.rmse, 0.005 + e.noise / 2, 0.02 + e.noise, false),
			`fit rms ${round(e.rmse)} of the change`,
		],
		[
			levelOf(e.observed, 0.9, 0.5),
			`${Math.round(e.observed * 100)} % of the change visible`,
		],
	];
	if (quality !== null)
		checks.push([
			levelOf(quality, 0.8, 0.5),
			`mean match quality ${round(quality, 2)}`,
		]);
	const weak = [
		...(e.weak ?? []),
		...checks.filter(([l]) => l === "low").map(([, why]) => why),
	];
	const lowest = Math.min(...checks.map(([l]) => LEVELS.indexOf(l)));
	return {
		confidence: e.weak?.length ? "low" : (LEVELS[lowest] as Level),
		support: {
			samples,
			rmse: round(e.rmse, 4),
			observed: round(e.observed),
			quality: quality === null ? null : round(quality),
			weak,
		},
	};
}
