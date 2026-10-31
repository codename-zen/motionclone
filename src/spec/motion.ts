import { type Candidate, classifyMotion, normalise } from "../fit/classify.ts";
import type { Hint, Sample } from "../fit/types.ts";
import {
	type MovingProperty,
	movingProperties,
	type Track,
} from "../measure/elements.ts";
import type { Property } from "../measure/series.ts";

const SCALES: Property[] = ["scale", "scaleX", "scaleY"];

export const elementKey = (selector: string, index: number) =>
	`${selector}[${index}]`;

const sameChange = (a: MovingProperty, b: MovingProperty) =>
	Math.abs(a.window.change - b.window.change) <=
	Math.max(0.5, 0.05 * Math.abs(b.window.change));

/** Moving properties without the ones another property explains: box x/y/size follow transforms, scaleX/Y follow uniform scale. */
export function motionProperties(track: Track): MovingProperty[] {
	const all = movingProperties(track);
	const byElement = new Map<string, Map<Property, MovingProperty>>();
	for (const m of all) {
		const key = elementKey(m.selector, m.index);
		const props = byElement.get(key) ?? new Map<Property, MovingProperty>();
		props.set(m.property, m);
		byElement.set(key, props);
	}
	return all.filter((m) => {
		const props = byElement.get(elementKey(m.selector, m.index)) as Map<
			Property,
			MovingProperty
		>;
		const has = (p: Property) => props.has(p);
		const transformed = SCALES.some(has) || has("rotate");
		switch (m.property) {
			case "x":
				return !has("translateX") && !transformed;
			case "y":
				return !has("translateY") && !transformed;
			case "width":
			case "height":
				return !transformed;
			case "scaleX":
			case "scaleY": {
				const scale = props.get("scale");
				return !scale || !sameChange(m, scale);
			}
			case "scale": {
				const sx = props.get("scaleX");
				const sy = props.get("scaleY");
				return (!sx || sameChange(sx, m)) && (!sy || sameChange(sy, m));
			}
			default:
				return true;
		}
	});
}

export interface FittedMotion {
	samples: Sample[];
	hint: Hint;
	best: Candidate;
	overshoot: number;
}

export function fitMotion(m: MovingProperty): FittedMotion {
	const { samples, hint } = normalise(m.series, m.window);
	const c = classifyMotion(m.series, m.window);
	return { samples, hint, best: c.best, overshoot: c.overshoot };
}

/** Every (selector, index) seen in any frame. */
export function trackedElements(
	track: Track,
): { selector: string; index: number }[] {
	const out: { selector: string; index: number }[] = [];
	for (const selector of track.selectors) {
		const seen = new Set<number>();
		for (const f of track.frames)
			for (const e of f.elements[selector] ?? []) seen.add(e.index);
		for (const index of [...seen].sort((a, b) => a - b))
			out.push({ selector, index });
	}
	return out;
}
