import type { ClipRect } from "../capture/options.ts";
import type { Track } from "../measure/elements.ts";
import { backgroundWindows } from "./background.ts";
import { readRegions } from "./frames.ts";
import { type ProgressWindow, progressWindows } from "./progress.ts";
import type { Rect } from "./region.ts";

export type { ProgressWindow } from "./progress.ts";
export { elementRegion, FRAME, frameRegion, type Rect } from "./region.ts";

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
): Promise<RegionProgress[]> {
	const t = track.frames.map((f) => f.t);
	const read = await readRegions(dir, t.length, clip, regions);
	return regions.map((region, i) => {
		const r = read[i];
		return {
			region,
			windows: !r?.rect
				? []
				: region.exclude
					? backgroundWindows(r.frames, t, track.frameMs)
					: progressWindows(r.frames, t, track.frameMs),
		};
	});
}
