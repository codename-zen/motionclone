import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrackFrame } from "../capture/types.ts";
import {
	extractSeries,
	PROPERTIES,
	type Property,
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
}

// Smallest total range that counts as movement, per property unit.
const MIN_RANGE: Record<Property, number> = {
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

/** Every tracked (selector, index) and property that moves, with its window. */
export function movingProperties(track: Track): MovingProperty[] {
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
				const window = motionWindow(series, {
					size: axis && firstBox ? firstBox[axis] : undefined,
				});
				if (window) out.push({ selector, index, property, window, series });
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
