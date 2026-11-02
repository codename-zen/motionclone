import type { AnimationRecord } from "../capture/types.ts";
import type { MovingProperty } from "../measure/elements.ts";
import { type CurveDeviation, curveDeviation } from "./deviation.ts";
import { curveSpanMs, declaredEasing } from "./easing.ts";
import type { FittedMotion } from "./motion.ts";
import { DEFAULT_TOLERANCES, type Easing } from "./schema.ts";

export interface Timing {
	startMs: number;
	durationMs: number;
	easing: Easing;
	rmse: number;
}

export interface Declared extends Timing {
	animation: AnimationRecord;
	deviation: CurveDeviation;
}

const FILTER_NAMES = new Set(["filter", "-webkit-filter"]);
const groupOfName = (name: string) =>
	name === "opacity"
		? "opacity"
		: FILTER_NAMES.has(name)
			? "filter"
			: "geometry";
const groupOfProperty = (p: string) =>
	p === "opacity" ? "opacity" : p === "blur" ? "filter" : "geometry";

// CSS transitions name their property, so an opacity transition cannot explain a transform, a filter or the reverse.
function canDrive(a: AnimationRecord, property: string): boolean {
	if (a.type !== "CSSTransition" || a.name === "all") return true;
	return groupOfName(a.name) === groupOfProperty(property);
}

/** The tracked element's CSS or WAAPI animation that explains this motion, checked against the track. */
export function matchDeclared(
	m: MovingProperty,
	fit: FittedMotion,
	animations: AnimationRecord[],
	frameMs: number,
	notes: string[],
): Declared | null {
	const startTol = Math.max(DEFAULT_TOLERANCES.startMs, frameMs);
	let best: Declared | null = null;
	for (const a of animations) {
		if (
			!a.tracked.some((t) => t.selector === m.selector && t.index === m.index)
		)
			continue;
		if (a.canceled || a.timeline !== "document" || a.startMs === null) continue;
		if (!canDrive(a, m.property)) continue;
		const label = `${a.type} ${a.name || "(unnamed)"}`;
		if (
			a.iterations !== 1 ||
			a.direction !== "normal" ||
			a.playbackRate !== 1 ||
			typeof a.duration !== "number"
		) {
			notes.push(
				`${label} repeats, reverses or has no fixed duration: measured instead`,
			);
			continue;
		}
		const easing = declaredEasing(a);
		if (!easing) {
			notes.push(
				`${label} easing "${a.easing}" is not one curve: measured instead`,
			);
			continue;
		}
		const startMs = a.startMs + a.delay;
		if (Math.abs(startMs - fit.best.delayMs) > startTol) continue;
		const deviation = curveDeviation(fit.samples, fit.hint, easing, {
			delayMs: startMs,
			spanMs: curveSpanMs(easing, a.duration),
		});
		if (deviation.max > DEFAULT_TOLERANCES.easing) {
			notes.push(
				`${label} does not match the track (max deviation ${deviation.max.toFixed(3)}): measured instead`,
			);
			continue;
		}
		if (!best || deviation.max < best.deviation.max)
			best = {
				startMs,
				durationMs: a.duration,
				easing,
				rmse: deviation.rmse,
				animation: a,
				deviation,
			};
	}
	return best;
}
