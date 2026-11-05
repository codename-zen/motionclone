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
	/**
	 * The motion's whole change, the frame time and the readings of the motion's own frames: a change that mostly
	 * falls between readings frames apart was not seen.
	 */
	change?: { value: number; frameMs: number; obs: readonly Observation[] };
}

// Plain readings this many frames apart or more leave the change between them unseen; when that is over
// UNSEEN_SHARE of the motion, the tracker did not see the motion happen.
const GAP_FRAMES = 5;
const UNSEEN_SHARE = 0.5;

/** The largest step between two plain readings GAP_FRAMES or more apart, as a share of the change, with its times. */
function unseenStep(
	change: NonNullable<SupportInput["change"]>,
): { share: number; fromMs: number; toMs: number } | null {
	const plain = change.obs.filter((o) => o.lo === o.hi && !o.filled);
	let best: { share: number; fromMs: number; toMs: number } | null = null;
	for (let k = 1; k < plain.length; k++) {
		const a = plain[k - 1] as Observation;
		const b = plain[k] as Observation;
		if (b.t - a.t < GAP_FRAMES * change.frameMs - 0.5) continue;
		const share =
			Math.abs(b.lo - a.lo) / Math.max(Math.abs(change.value), 1e-9);
		if (!best || share > best.share) best = { share, fromMs: a.t, toMs: b.t };
	}
	return best;
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
	const gap = e.change ? unseenStep(e.change) : null;
	if (gap && gap.share > UNSEEN_SHARE)
		checks.push([
			"low",
			`${Math.round(gap.share * 100)} % of the change falls between the readings at ${Math.round(gap.fromMs)} and ${Math.round(gap.toMs)} ms, where the element was not seen`,
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
