import {
	type MovingProperty,
	movingProperties,
	type Track,
} from "../measure/elements.ts";
import { elementKey, type FittedMotion, fitMotion } from "../spec/motion.ts";

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
}

export function indexClone(track: Track): CloneIndex {
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
	return { frameMs: track.frameMs, moving, present, matched, byElement };
}

export function measureClone(
	idx: CloneIndex,
	selector: string,
	index: number,
	property: string,
): CloneMotion {
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
	return {
		status: "moving",
		motion,
		fit,
		startMs: fit.best.delayMs,
		durationMs: fit.best.durationMs,
	};
}
