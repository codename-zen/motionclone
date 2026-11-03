import type { AnimationRecord } from "../capture/types.ts";
import { fitTiming } from "../fit/bezier.ts";
import {
	type MovingProperty,
	movingProperties,
	type Track,
} from "../measure/elements.ts";
import { matchDeclared } from "../spec/declared.ts";
import { candidateEasing, curveSpanMs, unitCurve } from "../spec/easing.ts";
import { elementKey, type FittedMotion, fitMotion } from "../spec/motion.ts";
import type { Easing, SpecRow } from "../spec/schema.ts";

export type CloneMotion =
	| { status: "missing"; matched: number }
	| {
			status: "static";
			/** Layout properties of the same element that move in place of the wanted one. */
			standIns: string[];
	  }
	| {
			status: "moving";
			motion: MovingProperty;
			fit: FittedMotion;
			startMs: number;
			durationMs: number;
			/** The clone's own easing: declared, or named by the free fit. */
			easing: Easing;
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
	/** Every moving property of the clone, unfiltered, by `selector[index].property`. */
	moving: Map<string, MovingProperty>;
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
	for (const m of movingProperties(track)) {
		const key = elementKey(m.selector, m.index);
		moving.set(`${key}.${m.property}`, m);
		byElement.set(key, [...(byElement.get(key) ?? []), m]);
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
		moving,
		present,
		matched,
		byElement,
		animations,
	};
}

type RowShape = Pick<
	SpecRow,
	"selector" | "index" | "property" | "easing" | "durationMs"
>;

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

export function measureClone(idx: CloneIndex, row: RowShape): CloneMotion {
	const { selector, index, property } = row;
	const key = elementKey(selector, index);
	if (!idx.present.has(key))
		return { status: "missing", matched: idx.matched.get(selector) ?? 0 };
	const motion = idx.moving.get(`${key}.${property}`);
	if (!motion)
		return {
			status: "static",
			standIns: (idx.byElement.get(key) ?? [])
				.map((m) => m.property)
				.filter((p) => STAND_INS[property]?.includes(p)),
		};
	const fit = fitMotion(motion);
	return { status: "moving", motion, fit, ...timingOf(motion, fit, row, idx) };
}
