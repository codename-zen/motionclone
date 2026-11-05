// Two rests of the element at the same place, CSS px.
const SAME_PLACE = 1;

const median = (v: number[]) =>
	[...v].sort((a, b) => a - b)[v.length >> 1] as number;

/**
 * Edge positions for frames where the element rests but its surface edge does not show, such as a white sheet on a
 * white page; null elsewhere. Each rest takes the edge's offset to the element from frames that show it at a rest
 * in the same place, or else holds the edge where a frame right beside such a rest shows it (the page switched
 * there while the edge had not moved yet), from the frame where the element had moved least. Rests with neither stay
 * empty: nothing shows where the edge is.
 */
export function restFills(
	leads: readonly (number | null)[],
	rest: readonly boolean[],
	edges: readonly (number | null)[],
): (number | null)[] {
	const runs: { from: number; to: number; at: number }[] = [];
	rest.forEach((r, k) => {
		const at = leads[k];
		if (!r || at === null || at === undefined) return;
		const last = runs.at(-1);
		if (last && last.to === k - 1 && Math.abs(last.at - at) <= SAME_PLACE)
			last.to = k;
		else runs.push({ from: k, to: k, at });
	});
	const shown = (k: number) => edges[k] !== null && edges[k] !== undefined;
	const out: (number | null)[] = edges.map(() => null);
	for (const run of runs) {
		const same = runs.filter((o) => Math.abs(o.at - run.at) <= SAME_PLACE);
		const offsets = same.flatMap((o) =>
			Array.from({ length: o.to - o.from + 1 }, (_, i) => o.from + i)
				.filter(shown)
				.map((k) => (edges[k] as number) - (leads[k] as number)),
		);
		// Of the frames beside such rests, the one where the element has left its rest the least.
		const beside = same
			.flatMap((o) =>
				[o.from - 1, o.to + 1].filter(shown).map((k) => ({
					pos: edges[k] as number,
					moved: Math.abs((leads[k] ?? o.at) - o.at),
				})),
			)
			.sort((a, b) => a.moved - b.moved)[0];
		for (let k = run.from; k <= run.to; k++) {
			if (shown(k)) continue;
			if (offsets.length > 0) out[k] = (leads[k] as number) + median(offsets);
			else if (beside) out[k] = beside.pos;
		}
	}
	return out;
}
