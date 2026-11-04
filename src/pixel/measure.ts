import type { ClipRect } from "../capture/options.ts";
import type { Track } from "../measure/elements.ts";
import { backgroundWindows } from "./background.ts";
import { readRegions } from "./frames.ts";
import { type ProgressWindow, progressWindows } from "./progress.ts";
import type { Rect } from "./region.ts";

export type { ProgressWindow } from "./progress.ts";
export { elementRegion, FRAME, frameRegion, type Rect } from "./region.ts";

/** Times a measurement stays inside, ms: frames beside them show the element in another state. */
export interface Span {
	firstMs: number;
	lastMs: number;
}

export interface RegionProgress {
	region: Rect;
	windows: ProgressWindow[];
}

/**
 * Appearance progress per region over a capture (page or video): its frames/ and the frame times of its track.
 * Regions are CSS px boxes in the track's coordinates; the capture's clip and frame size place them in pixels.
 */
export async function measureProgress(
	dir: string,
	track: Track,
	clip: ClipRect,
	regions: readonly Rect[],
	spans: readonly (Span | null)[] = [],
): Promise<RegionProgress[]> {
	const t = track.frames.map((f) => f.t);
	const read = await readRegions(dir, t.length, clip, regions);
	return regions.map((region, i) => {
		const r = read[i];
		if (!r?.rect) return { region, windows: [] };
		// A span keeps the frames strictly between its two ends: the frames beside it show another state.
		const span = spans[i];
		const ks = t.flatMap((x, k) =>
			!span || (x > span.firstMs && x < span.lastMs) ? [k] : [],
		);
		const frames = ks.map((k) => r.frames[k] as Uint8Array);
		const ts = ks.map((k) => t[k] as number);
		const k0 = ks[0] ?? 0;
		const windows = region.exclude
			? backgroundWindows(frames, ts, track.frameMs)
			: progressWindows(frames, ts, track.frameMs);
		return {
			region,
			windows: windows.map((w) => ({
				...w,
				fromFrame: w.fromFrame + k0,
				toFrame: w.toFrame + k0,
			})),
		};
	});
}
