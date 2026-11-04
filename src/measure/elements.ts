import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrackFrame } from "../capture/types.ts";
import { afterSnap, splitAtRests } from "./segments.ts";
import {
	extractSeries,
	PROPERTIES,
	type Property,
	readProperty,
	type Series,
} from "./series.ts";
import { type MotionWindow, motionWindow } from "./window.ts";

export interface Track {
	selectors: string[];
	frameMs: number;
	frames: TrackFrame[];
}

export interface MovingProperty {
	selector: string;
	index: number;
	property: Property;
	window: MotionWindow;
	series: Series;
	/** 1 for the first of several motions of this property separated by rests, 2 for the next; absent when it moves once. */
	ordinal?: number;
}

// Smallest total range that counts as movement, per property unit.
export const MIN_RANGE: Record<Property, number> = {
	opacity: 0.01,
	translateX: 0.5,
	translateY: 0.5,
	scale: 0.005,
	scaleX: 0.005,
	scaleY: 0.005,
	rotate: 0.5,
	x: 0.5,
	y: 0.5,
	width: 0.5,
	height: 0.5,
	blur: 0.1,
};

const AXIS: Partial<Record<Property, "w" | "h">> = {
	translateX: "w",
	x: "w",
	width: "w",
	translateY: "h",
	y: "h",
	height: "h",
};

export async function readTrack(dir: string): Promise<Track> {
	return JSON.parse(await readFile(join(dir, "track.json"), "utf8")) as Track;
}

/**
 * Every tracked (selector, index) and property that moves, with its window; a property that moves several times,
 * with rests between, gives one entry per motion unless `split` is false.
 */
export function movingProperties(
	track: Track,
	{ split = true }: { split?: boolean } = {},
): MovingProperty[] {
	const out: MovingProperty[] = [];
	for (const selector of track.selectors) {
		const indices = new Set<number>();
		for (const f of track.frames)
			for (const e of f.elements[selector] ?? []) indices.add(e.index);
		for (const index of [...indices].sort((a, b) => a - b)) {
			const firstBox = track.frames
				.map((f) => f.elements[selector]?.find((e) => e.index === index))
				.find((e) => e !== undefined);
			for (const property of PROPERTIES) {
				const series = extractSeries(track.frames, selector, index, property);
				const values = series.map((p) => p[1]);
				if (Math.max(...values) - Math.min(...values) < MIN_RANGE[property])
					continue;
				const axis = AXIS[property];
				// The box is drawn under the element's scale; the size a distance is relative to is the unscaled one.
				const scale =
					axis && firstBox
						? Math.abs(
								readProperty(firstBox, axis === "w" ? "scaleX" : "scaleY"),
							)
						: 1;
				const size =
					axis && firstBox && scale > 0 ? firstBox[axis] / scale : undefined;
				const pieces = split
					? splitAtRests(series, MIN_RANGE[property])
					: [series];
				// Snaps are told apart only between motions; a lone there-and-back move stays whole.
				const found = pieces
					.map((p) => (pieces.length > 1 ? afterSnap(p) : p))
					.flatMap((piece) => {
						const window = motionWindow(piece, { size });
						return window ? [{ window, series: piece }] : [];
					});
				for (const [k, f] of found.entries())
					out.push({
						selector,
						index,
						property,
						...f,
						...(found.length > 1 ? { ordinal: k + 1 } : {}),
					});
			}
		}
	}
	return out;
}

export async function listMovingElements(
	dir: string,
): Promise<MovingProperty[]> {
	return movingProperties(await readTrack(dir));
}
