import type { RegionSample } from "./samples.ts";

/** Fill frames where the element was not found: interpolate inside, extrapolate one frame at the edges, then hold. */
export function fillLost(v: number[], found: boolean[]): number[] {
	const out = [...v];
	const idx = found.flatMap((f, i) => (f ? [i] : []));
	if (idx.length === 0) return out.fill(0);
	for (let a = 0; a + 1 < idx.length; a++) {
		const i = idx[a] as number;
		const j = idx[a + 1] as number;
		for (let k = i + 1; k < j; k++)
			out[k] =
				(v[i] as number) +
				(((v[j] as number) - (v[i] as number)) * (k - i)) / (j - i);
	}
	const edge = (at: number, inner: number | undefined, step: number) => {
		const next = at - step;
		if (next < 0 || next >= v.length) return;
		const slope =
			inner !== undefined && found[at + step]
				? (v[at] as number) - (v[inner] as number)
				: 0;
		for (let k = next; k >= 0 && k < v.length; k -= step)
			out[k] = (v[at] as number) + slope;
	};
	const firstIdx = idx[0] as number;
	const lastIdx = idx.at(-1) as number;
	edge(firstIdx, firstIdx + 1, 1);
	edge(lastIdx, lastIdx - 1, -1);
	return out;
}

/** Fill position over frames where the element was lost, and scale and blur over frames too faint to show them. */
export function fillSamples(smp: RegionSample[], shaped: boolean[]): void {
	const found = smp.map((p) => p.found);
	const dx = fillLost(
		smp.map((p) => p.dx),
		found,
	);
	const dy = fillLost(
		smp.map((p) => p.dy),
		found,
	);
	const logS = fillLost(
		smp.map((p) => Math.log(p.scale)),
		shaped,
	);
	const blur = fillLost(
		smp.map((p) => p.blur),
		shaped,
	);
	smp.forEach((p, k) => {
		p.dx = dx[k] as number;
		p.dy = dy[k] as number;
		p.scale = Math.exp(logS[k] as number);
		p.blur = Math.max(0, blur[k] as number);
	});
}
