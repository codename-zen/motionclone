import {
	type Candidate,
	classifyMotion,
	normaliseIn,
} from "../fit/classify.ts";
import type { TimeBounds } from "../fit/plausible.ts";
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

/** Row id of a motion: `sheet[0].y`, then `sheet[0].y#2` for its second motion, as progress rows are numbered. */
export const motionId = (
	m: Pick<MovingProperty, "selector" | "index" | "property" | "ordinal">,
) =>
	`${elementKey(m.selector, m.index)}.${m.property}${(m.ordinal ?? 1) > 1 ? `#${m.ordinal}` : ""}`;

/** Times a split motion's series covers, or undefined for a property that moves once. */
export const motionRange = (
	m: Pick<MovingProperty, "series" | "ordinal">,
): [number, number] | undefined =>
	m.ordinal === undefined
		? undefined
		: [m.series[0]?.[0] ?? 0, m.series.at(-1)?.[0] ?? 0];

const sameChange = (a: MovingProperty, b: MovingProperty) =>
	Math.abs(a.window.change - b.window.change) <=
	Math.max(0.5, 0.05 * Math.abs(b.window.change));

// Pixel trackers jitter by a pixel or two, so travel must also exceed a share of the element size.
const MIN_TRAVEL = 0.02;

// Scaling about any origin inside the box moves its centre by at most |change in scale| * size / 2.
// A centre that moves further travels on its own, as video tracks report position on the box.
function travelsBeyondScale(
	track: Track,
	m: MovingProperty,
	props: Map<Property, MovingProperty>,
): boolean {
	if (props.has("rotate")) return false;
	const horizontal = m.property === "x";
	const scale =
		props.get(horizontal ? "scaleX" : "scaleY") ?? props.get("scale");
	if (!scale) return false;
	const boxes = track.frames
		.map((f) => f.elements[m.selector]?.find((e) => e.index === m.index))
		.filter((e) => e !== undefined);
	const first = boxes[0];
	const s0 = scale.series[0]?.[1] ?? 1;
	if (!first || s0 === 0) return false;
	const centre = (e: (typeof boxes)[number]) =>
		horizontal ? e.x + e.w / 2 : e.y + e.h / 2;
	const size = (horizontal ? first.w : first.h) / Math.abs(s0);
	const ds = Math.max(...scale.series.map(([, v]) => Math.abs(v - s0)));
	const travel = Math.max(
		...boxes.map((e) => Math.abs(centre(e) - centre(first))),
	);
	return travel > (ds * size) / 2 + Math.max(1, MIN_TRAVEL * size);
}

/** Moving properties without the ones another property explains: box x/y/size follow transforms, scaleX/Y follow uniform scale. */
export function motionProperties(track: Track): MovingProperty[] {
	const all = movingProperties(track);
	const byElement = new Map<string, Map<Property, MovingProperty>>();
	for (const m of all) {
		const key = elementKey(m.selector, m.index);
		const props = byElement.get(key) ?? new Map<Property, MovingProperty>();
		// Whether a property is explained by another is decided on its first motion.
		if (!props.has(m.property)) props.set(m.property, m);
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
				return (
					!has("translateX") &&
					(!transformed || travelsBeyondScale(track, m, props))
				);
			case "y":
				return (
					!has("translateY") &&
					(!transformed || travelsBeyondScale(track, m, props))
				);
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

/** Fit a series over its motion window; any series with a window, a tracked property or a pixel progress curve. */
export function fitMotion(
	m: Pick<MovingProperty, "series" | "window">,
	bounds?: TimeBounds,
): FittedMotion {
	const { samples, hint } = normaliseIn(m.series, m.window, bounds);
	const c = classifyMotion(m.series, m.window, bounds);
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
