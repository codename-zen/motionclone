import type { ClipRect } from "../capture/options.ts";
import type { TrackedElement } from "../capture/types.ts";
import type { Track } from "../measure/elements.ts";
import {
	EDGE,
	edgeSetup,
	isEdge,
	readEdges,
	surfaceEdge,
	withEdgeTrack,
} from "../pixel/surface.ts";

/** The capture warning for a region whose surface edge is tracked, naming both as rows name them. */
export function edgeWarning(selector: string, index: number): string {
	const at = index > 0 ? `[${index}]` : "";
	return `region ${selector}${at}: a surface edge beside the tracked content moves apart from it; it is tracked as ${selector}${EDGE}${at}, so its timing, easing and travel get rows of their own`;
}

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
			const kinds = await readEdges(dir, track, clip, setup, selector, index);
			const elements = surfaceEdge(
				track,
				selector,
				index,
				setup,
				kinds,
				false,
				clip,
			);
			if (!elements) continue;
			added.push({ selector, index, elements });
			warnings.push(edgeWarning(selector, index));
		}
	}
	return withEdgeTrack(track, added);
}
