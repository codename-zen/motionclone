import type { ClipRect } from "../capture/options.ts";
import type { TrackedElement } from "../capture/types.ts";
import type { Track } from "../measure/elements.ts";
import {
	EDGE,
	edgeElements,
	edgeSetup,
	isEdge,
	readEdges,
	withEdgeTrack,
} from "../pixel/surface.ts";

/**
 * Regions lock onto distinctive content, such as a strip of text riding on a sheet. Where the sheet's own edge moves
 * apart from that content (it trails it, or overshoots), the edge is tracked too, as `<region>::edge` (ADR 0002).
 */
export async function trackSurfaceEdges(
	dir: string,
	track: Track,
	clip: ClipRect,
	warnings: string[],
): Promise<Track> {
	const added: {
		selector: string;
		index: number;
		elements: (TrackedElement | null)[];
	}[] = [];
	for (const selector of track.selectors.filter((s) => !isEdge(s))) {
		const indexes = new Set(
			track.frames.flatMap((f) =>
				(f.elements[selector] ?? []).map((e) => e.index),
			),
		);
		for (const index of indexes) {
			const setup = edgeSetup(track, selector, index);
			if (!setup) continue;
			const edges = await readEdges(dir, track, clip, setup, selector, index);
			const elements = edgeElements(track, selector, index, setup, edges);
			if (!elements) continue;
			added.push({ selector, index, elements });
			warnings.push(
				`region ${selector}${index > 0 ? `[${index}]` : ""}: a surface edge beside the tracked content moves apart from it; it is tracked as ${selector}${EDGE}, so its timing, easing and travel get rows of their own`,
			);
		}
	}
	return withEdgeTrack(track, added);
}
