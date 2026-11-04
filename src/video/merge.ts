import type { RegionSample, RegionTrack } from "./samples.ts";

const centre = (t: RegionTrack, p: RegionSample) => ({
	x: t.box.x + t.box.w / 2 + p.dx,
	y: t.box.y + t.box.h / 2 + p.dy,
});

const median = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2
		? (s[m] as number)
		: ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * Fill the frames one track did not find from the track of the other end, converted to the first track's box
 * through the frames where both measured scale; returns how many frames were filled (none without such frames).
 */
export function mergeEnds(main: RegionTrack, other: RegionTrack): number {
	const both = main.samples.flatMap((p, k) =>
		p.status === "found" && other.samples[k]?.status === "found" ? [k] : [],
	);
	if (both.length === 0) return 0;
	const pairs = both.map((k) => ({
		a: main.samples[k] as RegionSample,
		b: other.samples[k] as RegionSample,
	}));
	const ratio = median(pairs.map(({ a, b }) => a.scale / b.scale));
	const ox = median(
		pairs.map(({ a, b }) => (centre(main, a).x - centre(other, b).x) / b.scale),
	);
	const oy = median(
		pairs.map(({ a, b }) => (centre(main, a).y - centre(other, b).y) / b.scale),
	);
	let filled = 0;
	main.samples.forEach((p, k) => {
		const q = other.samples[k] as RegionSample;
		if (p.found || !q.found) return;
		const c = centre(other, q);
		Object.assign(p, {
			...q,
			dx: c.x + q.scale * ox - main.box.x - main.box.w / 2,
			dy: c.y + q.scale * oy - main.box.y - main.box.h / 2,
			scale: q.scale * ratio,
			// The frame shows blur times scale, the same from either reference.
			blur: q.blur / ratio,
			centroid: p.centroid,
			energy: p.energy,
		});
		filled++;
	});
	return filled;
}

/**
 * Express a track against the element as it appears at one of its frames: box, scale and blur.
 * Does nothing unless that frame measured the scale.
 */
export function rebase(
	t: RegionTrack,
	k: number,
	label: RegionTrack["ref"],
): void {
	const at = t.samples[k] as RegionSample;
	if (at.status !== "found") return;
	const s0 = at.scale;
	const c0 = centre(t, at);
	const box = {
		x: c0.x - (t.box.w * s0) / 2,
		y: c0.y - (t.box.h * s0) / 2,
		w: t.box.w * s0,
		h: t.box.h * s0,
	};
	for (const p of t.samples) {
		const c = centre(t, p);
		Object.assign(p, {
			dx: c.x - c0.x,
			dy: c.y - c0.y,
			scale: p.scale / s0,
			blur: p.blur * s0,
		});
	}
	Object.assign(t, { box, ref: label, refFrame: k });
}
