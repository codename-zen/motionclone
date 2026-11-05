import type { TrackedElement, TrackFrame } from "../capture/types.ts";
import { blurPx, effectiveMatrix, type Matrix, parseMatrix } from "./style.ts";

export const PROPERTIES = [
	"opacity",
	"translateX",
	"translateY",
	"scale",
	"scaleX",
	"scaleY",
	"rotate",
	"x",
	"y",
	"width",
	"height",
	"blur",
] as const;

export type Property = (typeof PROPERTIES)[number];
/** [tMs, value] */
export type Point = readonly [number, number];
export type Series = Point[];

export interface Decomposed {
	translateX: number;
	translateY: number;
	scaleX: number;
	scaleY: number;
	scale: number;
	/** Degrees. */
	rotate: number;
}

const IDENTITY: Decomposed = {
	translateX: 0,
	translateY: 0,
	scaleX: 1,
	scaleY: 1,
	scale: 1,
	rotate: 0,
};

/** Decompose a 2D matrix into translate, scale and rotate; skew is ignored. */
function decomposeMatrix(m: Matrix | null): Decomposed {
	if (!m) return IDENTITY;
	const [a, b, c, d, e, f] = m;
	const det = a * d - b * c;
	const sx = Math.hypot(a, b);
	return {
		translateX: e,
		translateY: f,
		scaleX: sx,
		scaleY: sx === 0 ? 0 : det / sx,
		scale: Math.sqrt(Math.abs(det)),
		rotate: (Math.atan2(b, a) * 180) / Math.PI,
	};
}

/** Decompose a computed transform (matrix or matrix3d) into translate, scale and rotate; skew is ignored. */
export const decompose = (transform: string): Decomposed =>
	decomposeMatrix(parseMatrix(transform));

const BOX = {
	x: "x",
	y: "y",
	width: "w",
	height: "h",
	opacity: "opacity",
} as const;

export function readProperty(el: TrackedElement, property: Property): number {
	// A video opacity proxy can read past either end; opacity itself cannot.
	if (property === "opacity") return Math.min(1, Math.max(0, el.opacity));
	if (property in BOX) return el[BOX[property as keyof typeof BOX]];
	if (property === "blur") return blurPx(el.filter);
	return decomposeMatrix(effectiveMatrix(el.transform, el, el))[
		property as keyof Decomposed
	];
}

const BOX_PROPERTIES = new Set<Property>(["x", "y", "width", "height"]);

/** A video tracker lost the element on this frame: its box is interpolated or held, not seen (ADR 0002). */
export const lost = (el: TrackedElement): boolean =>
	el.observed !== undefined && !el.observed.position && !el.observed.opacity;

/** A video tracker did not measure this scale or blur on this frame: it is filled in from other frames. */
const unseenShape = (el: TrackedElement, property: Property): boolean =>
	property === "blur"
		? el.observed?.blur === false
		: property.startsWith("scale") && el.observed?.scale === false;

/**
 * One value per frame for a tracked element; rotation is unwrapped so 359 to 1 degrees is a 2 degree move.
 * Video boxes on frames where the tracker lost the element after first finding it are left out: they are
 * interpolated, not seen. So are scale and blur the tracker filled in after it first measured them. Leading ones
 * stay, as the extrapolated start (ADR 0003).
 */
export function extractSeries(
	frames: readonly TrackFrame[],
	selector: string,
	index: number,
	property: Property,
): Series {
	const out: Series = [];
	let offset = 0;
	let prev: number | null = null;
	let found = false;
	for (const frame of frames) {
		const el = frame.elements[selector]?.find((e) => e.index === index);
		if (!el) continue;
		const missing = BOX_PROPERTIES.has(property)
			? lost(el)
			: unseenShape(el, property);
		if (missing) {
			if (found) continue;
		} else found = true;
		let value = readProperty(el, property);
		if (property === "rotate") {
			if (prev !== null) {
				while (value + offset - prev > 180) offset -= 360;
				while (value + offset - prev < -180) offset += 360;
			}
			value += offset;
			prev = value;
		}
		out.push([frame.t, value]);
	}
	return out;
}

/** Linear interpolation, clamped to the first and last sample. */
export function valueAt(series: Series, t: number): number {
	const first = series[0];
	const last = series.at(-1);
	if (!first || !last) return Number.NaN;
	if (t <= first[0]) return first[1];
	if (t >= last[0]) return last[1];
	let lo = 0;
	let hi = series.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if ((series[mid] as Point)[0] <= t) lo = mid;
		else hi = mid;
	}
	const [t0, v0] = series[lo] as Point;
	const [t1, v1] = series[hi] as Point;
	return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}
