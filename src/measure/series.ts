import type { TrackedElement, TrackFrame } from "../capture/types.ts";

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

/** Decompose a computed transform (matrix or matrix3d) into translate, scale and rotate; skew is ignored. */
export function decompose(transform: string): Decomposed {
	const m = /^(matrix3d|matrix)\(([^)]*)\)$/.exec(transform.trim());
	if (!m) return IDENTITY;
	const v = (m[2] ?? "").split(",").map(Number);
	const is3d = m[1] === "matrix3d";
	if (v.length !== (is3d ? 16 : 6) || v.some((n) => !Number.isFinite(n)))
		return IDENTITY;
	const [a, b, c, d, e, f] = is3d ? [v[0], v[1], v[4], v[5], v[12], v[13]] : v;
	const [ra, rb, rc, rd] = [a, b, c, d].map((n) => n as number);
	const det = (ra as number) * (rd as number) - (rb as number) * (rc as number);
	const sx = Math.hypot(ra as number, rb as number);
	return {
		translateX: e as number,
		translateY: f as number,
		scaleX: sx,
		scaleY: sx === 0 ? 0 : det / sx,
		scale: Math.sqrt(Math.abs(det)),
		rotate: (Math.atan2(rb as number, ra as number) * 180) / Math.PI,
	};
}

const BOX = {
	x: "x",
	y: "y",
	width: "w",
	height: "h",
	opacity: "opacity",
} as const;

export function readProperty(el: TrackedElement, property: Property): number {
	if (property in BOX) return el[BOX[property as keyof typeof BOX]];
	return decompose(el.transform)[property as keyof Decomposed];
}

/** One value per frame for a tracked element; rotation is unwrapped so 359 to 1 degrees is a 2 degree move. */
export function extractSeries(
	frames: readonly TrackFrame[],
	selector: string,
	index: number,
	property: Property,
): Series {
	const out: Series = [];
	let offset = 0;
	let prev: number | null = null;
	for (const frame of frames) {
		const el = frame.elements[selector]?.find((e) => e.index === index);
		if (!el) continue;
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
