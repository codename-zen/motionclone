import type { ClipRect } from "../capture/options.ts";
import type { TrackedElement } from "../capture/types.ts";
import type { Track } from "../measure/elements.ts";
import { placeRegion } from "../verify/progress.ts";
import {
	edgeElements,
	edgeOwner,
	edgeSetup,
	isEdge,
	readEdges,
	withEdgeTrack,
} from "./surface.ts";

/**
 * The clone track with the surface edges the reference tracks, read from the clone's frames the way the reference's
 * were (ADR 0004): in the reference's band placed on the clone, next to the clone's element of the same name.
 */
export async function withCloneEdges(
	cloneDir: string,
	clone: Track,
	cloneClip: ClipRect,
	ref: Track,
	refClip: ClipRect,
): Promise<Track> {
	const added: {
		selector: string;
		index: number;
		elements: (TrackedElement | null)[];
	}[] = [];
	for (const selector of ref.selectors.filter(isEdge)) {
		// A clone that tracks the edge itself, with --map, answers for it directly.
		if (clone.selectors.includes(selector)) continue;
		const owner = edgeOwner(selector);
		const indexes = new Set(
			ref.frames.flatMap((f) =>
				(f.elements[selector] ?? []).map((e) => e.index),
			),
		);
		for (const index of indexes) {
			const setup = edgeSetup(ref, owner, index);
			if (!setup) continue;
			const placed = {
				axis: setup.axis,
				band: placeRegion(setup.band, refClip, cloneClip),
			};
			const edges = await readEdges(
				cloneDir,
				clone,
				cloneClip,
				placed,
				owner,
				index,
			);
			const elements = edgeElements(clone, owner, index, placed, edges, true);
			if (elements) added.push({ selector: owner, index, elements });
		}
	}
	return withEdgeTrack(clone, added);
}
