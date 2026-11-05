import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** The file verify writes the clone's edge readings to, beside verdict.json. */
export const CLONE_EDGES = "clone-edges.json";

/**
 * The clone track with the surface edges the reference tracks, read from the clone's frames the way the reference's
 * were (ADR 0004): in the reference's band placed on the clone, next to the clone's element of the same name.
 * With `outDir`, the readings are also written there, per frame, so they can be compared with the reference's.
 */
export async function withCloneEdges(
	cloneDir: string,
	clone: Track,
	cloneClip: ClipRect,
	ref: Track,
	refClip: ClipRect,
	outDir: string | null = null,
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
			const elements = edgeElements(
				clone,
				owner,
				index,
				placed,
				edges,
				true,
				cloneClip,
			);
			if (elements) added.push({ selector: owner, index, elements });
		}
	}
	const out = withEdgeTrack(clone, added);
	if (outDir && added.length > 0)
		await writeFile(
			join(outDir, CLONE_EDGES),
			`${JSON.stringify(
				{
					note: "the clone's surface edges, read from its frames as the reference's were; null where none shows",
					edges: added.map((a) => ({
						selector: `${a.selector}::edge`,
						index: a.index,
						frames: a.elements.map((e, k) => ({
							t: clone.frames[k]?.t,
							x: e?.x ?? null,
							y: e?.y ?? null,
						})),
					})),
				},
				null,
				"	",
			)}
`,
		);
	return out;
}
