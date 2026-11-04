import type { AnimationRecord } from "../capture/types.ts";
import { fitTiming } from "../fit/bezier.ts";
import type { TimeBounds } from "../fit/plausible.ts";
import {
	type MovingProperty,
	movingProperties,
	type Track,
} from "../measure/elements.ts";
import { FRAME } from "../pixel/region.ts";
import { matchDeclared } from "../spec/declared.ts";
import { candidateEasing, curveSpanMs, unitCurve } from "../spec/easing.ts";
import { elementKey, type FittedMotion, fitMotion } from "../spec/motion.ts";
import { trackBounds } from "../spec/plausible-rows.ts";
import type { Easing, SpecRow } from "../spec/schema.ts";
import { ordinalOf } from "./motion-count.ts";

export type CloneMotion =
	| { status: "missing"; matched: number }
	| {
			status: "static";
			/** Layout properties of the same element that move in place of the wanted one. */
			standIns: string[];
			/** Set when the clone moves this property, but fewer times than the spec wants. */
			count?: { got: number; want: number };
	  }
	| {
			status: "moving";
			motion: Pick<MovingProperty, "series" | "window">;
			fit: FittedMotion;
			startMs: number;
			durationMs: number;
			/** The clone's own easing: declared, or named by the free fit. */
			easing: Easing;
			/** How this clone row was measured, when it differs from the usual track fit. */
			notes?: string[];
	  };

const STAND_INS: Record<string, string[]> = {
	translateX: ["x"],
	translateY: ["y"],
	scale: ["width", "height"],
	scaleX: ["width"],
	scaleY: ["height"],
};

export interface CloneIndex {
	frameMs: number;
	/** The clone capture's first and last frame: its fits stay inside them, as drafting's do. */
	bounds: TimeBounds;
	/** Every moving property of the clone, unfiltered and whole, by `selector[index].property`. */
	moving: Map<string, MovingProperty>;
	/** The same, one entry per motion where a property moves several times with rests between, in time order. */
	motions: Map<string, MovingProperty[]>;
	present: Set<string>;
	matched: Map<string, number>;
	/** Moving properties per element key. */
	byElement: Map<string, MovingProperty[]>;
	animations: AnimationRecord[];
}

export function indexClone(
	track: Track,
	animations: AnimationRecord[] = [],
): CloneIndex {
	const moving = new Map<string, MovingProperty>();
	const byElement = new Map<string, MovingProperty[]>();
	for (const m of movingProperties(track, { split: false })) {
		const key = elementKey(m.selector, m.index);
		moving.set(`${key}.${m.property}`, m);
		byElement.set(key, [...(byElement.get(key) ?? []), m]);
	}
	const motions = new Map<string, MovingProperty[]>();
	for (const m of movingProperties(track)) {
		const key = `${elementKey(m.selector, m.index)}.${m.property}`;
		motions.set(key, [...(motions.get(key) ?? []), m]);
	}
	const present = new Set<string>();
	const matched = new Map<string, number>();
	for (const f of track.frames)
		for (const [selector, list] of Object.entries(f.elements)) {
			matched.set(selector, Math.max(matched.get(selector) ?? 0, list.length));
			for (const e of list) present.add(elementKey(selector, e.index));
		}
	return {
		frameMs: track.frameMs,
		bounds: trackBounds(track, track.frameMs),
		moving,
		motions,
		present,
		matched,
		byElement,
		animations,
	};
}

type RowShape = Pick<
	SpecRow,
	"id" | "selector" | "index" | "property" | "easing" | "durationMs" | "startMs"
>;

// Time two ranges share, negative for the gap between them.
const overlap = (a0: number, a1: number, b0: number, b1: number) =>
	Math.min(a1, b1) - Math.max(a0, b0);

/** The clone motion that shares the most time with the row's, or the one starting nearest it. */
export function nearestMotion(
	motions: readonly MovingProperty[],
	row: Pick<SpecRow, "startMs" | "durationMs">,
): MovingProperty | undefined {
	const end = row.startMs + row.durationMs;
	const score = (m: MovingProperty) =>
		overlap(row.startMs, end, m.window.startMs, m.window.endMs) -
		1e-6 * Math.abs(m.window.startMs - row.startMs);
	return [...motions].sort((a, b) => score(b) - score(a))[0];
}

// Measured the way the reference was: declared timing when an animation explains the track, else the row's curve held fixed.
function timingOf(
	motion: MovingProperty,
	fit: FittedMotion,
	row: RowShape,
	idx: CloneIndex,
): { startMs: number; durationMs: number; easing: Easing } {
	const declared = matchDeclared(motion, fit, idx.animations, idx.frameMs, []);
	if (declared) {
		const { startMs, durationMs, easing } = declared;
		return { startMs, durationMs, easing };
	}
	return measuredTiming(fit, row);
}

/** The clone's timing with the row's easing held fixed, as a measured reference row was fitted (ADR 0004). */
export function measuredTiming(
	fit: FittedMotion,
	row: Pick<SpecRow, "easing" | "durationMs">,
): { startMs: number; durationMs: number; easing: Easing } {
	const easing = candidateEasing(fit.best);
	// Step plateaus defeat the timing optimiser; the free fit already grid-searches them.
	if (row.easing.type === "steps")
		return {
			startMs: fit.best.delayMs,
			durationMs: fit.best.durationMs,
			easing,
		};
	const t = fitTiming(fit.samples, fit.hint, unitCurve(row.easing));
	const span = curveSpanMs(row.easing, row.durationMs);
	return {
		startMs: t.delayMs,
		durationMs: (t.durationMs * row.durationMs) / span,
		easing,
	};
}

/**
 * The clone's motion for a spec row. When the spec wants several motions of this property, row #n is paired with
 * the clone's n-th motion in time; when it wants one and the clone moves it several times, with the motion nearest
 * the row in time; otherwise with the property's whole series.
 */
export function measureClone(
	idx: CloneIndex,
	row: RowShape,
	want = 1,
): CloneMotion {
	const { selector, index, property } = row;
	const key = elementKey(selector, index);
	// The frame is always there; its rows are measured from pixels.
	if (selector === FRAME) return { status: "static", standIns: [] };
	if (!idx.present.has(key))
		return { status: "missing", matched: idx.matched.get(selector) ?? 0 };
	const all = idx.motions.get(`${key}.${property}`) ?? [];
	const motion =
		want > 1
			? all[ordinalOf(row.id) - 1]
			: all.length > 1
				? nearestMotion(all, row)
				: idx.moving.get(`${key}.${property}`);
	if (!motion)
		return {
			status: "static",
			standIns: (idx.byElement.get(key) ?? [])
				.map((m) => m.property)
				.filter((p) => STAND_INS[property]?.includes(p)),
			...(all.length > 0 ? { count: { got: all.length, want } } : {}),
		};
	const fit = fitMotion(motion, idx.bounds);
	return { status: "moving", motion, fit, ...timingOf(motion, fit, row, idx) };
}
