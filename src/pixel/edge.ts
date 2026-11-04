import type { PNG } from "pngjs";

/** A straight boundary between two flat areas, across most of a band: the edge of a large surface. */
export interface Edge {
	/** Position along the axis, frame pixels: the boundary lies just before this row (or column). */
	pos: number;
	/** Mean luma step across it, levels; the sign says which side is lighter. */
	step: number;
}

/** Frame pixels: lines a0..a1 across the edge (columns for a horizontal edge), positions b0..b1 along the axis. */
export interface EdgeBand {
	axis: "x" | "y";
	a0: number;
	a1: number;
	b0: number;
	b1: number;
}

// A surface edge steps at least this many luma levels on most lines across the middle of the band; content beside
// it (text the surface slides past) may hide it on the rest. The surface side itself is flat on nearly every line.
const MIN_STEP = 24;
const SHARE = 0.75;
const FLAT = 12;
const FLAT_SHARE = 0.9;
// Lines read across the band, at most; the middle half only, so rounded corners do not count against it.
const LINES = 48;
// Pixels averaged on each side of a candidate boundary.
const SIDE = 3;

const luma = (png: PNG, x: number, y: number) => {
	const p = (y * png.width + x) * 4;
	return (
		0.299 * (png.data[p] as number) +
		0.587 * (png.data[p + 1] as number) +
		0.114 * (png.data[p + 2] as number)
	);
};

/** Running sums of luma along one line of the band, from b0 - SIDE. */
function profile(
	png: PNG,
	band: EdgeBand,
	a: number,
	from: number,
	to: number,
) {
	const sums = new Float64Array(to - from + 1);
	for (let b = from; b < to; b++)
		sums[b - from + 1] =
			(sums[b - from] as number) +
			(band.axis === "y" ? luma(png, a, b) : luma(png, b, a));
	return (b0: number, b1: number) =>
		((sums[b1 - from] as number) - (sums[b0 - from] as number)) / (b1 - b0);
}

/** Every surface edge in the band on one frame, strongest step first. */
export function edgesIn(png: PNG, band: EdgeBand): Edge[] {
	const along = band.axis === "y" ? png.height : png.width;
	const across = band.axis === "y" ? png.width : png.height;
	const a0 = Math.max(0, Math.round(band.a0 + (band.a1 - band.a0) / 4));
	const a1 = Math.min(across, Math.round(band.a1 - (band.a1 - band.a0) / 4));
	const from = Math.max(0, band.b0 - SIDE);
	const to = Math.min(along, band.b1 + SIDE);
	if (a1 <= a0 || to - from < 2 * SIDE + 1) return [];
	const every = Math.max(1, Math.floor((a1 - a0) / LINES));
	const lines: ((b0: number, b1: number) => number)[] = [];
	for (let a = a0; a < a1; a += every)
		lines.push(profile(png, band, a, from, to));
	const need = Math.ceil(SHARE * lines.length);
	const flat = (v: number[]) => {
		const m = [...v].sort((p, q) => p - q)[v.length >> 1] as number;
		return (
			v.filter((x) => Math.abs(x - m) <= FLAT).length >= FLAT_SHARE * v.length
		);
	};
	const score: number[] = [];
	for (let b = from + SIDE; b <= to - SIDE; b++) {
		const after = lines.map((mean) => mean(b, b + SIDE));
		const before = lines.map((mean) => mean(b - SIDE, b));
		let up = 0;
		let down = 0;
		let sum = 0;
		after.forEach((v, i) => {
			const d = v - (before[i] as number);
			if (d >= MIN_STEP) up++;
			else if (d <= -MIN_STEP) down++;
			sum += d;
		});
		const edge = (up >= need || down >= need) && (flat(after) || flat(before));
		score.push(edge ? sum / lines.length : 0);
	}
	const out: Edge[] = [];
	let i = 0;
	while (i < score.length) {
		const s = score[i] as number;
		if (s === 0) {
			i++;
			continue;
		}
		let j = i;
		let w = 0;
		let wb = 0;
		let peak = 0;
		while (j < score.length && Math.sign(score[j] as number) === Math.sign(s)) {
			const v = Math.abs(score[j] as number);
			w += v;
			wb += v * (from + SIDE + j);
			peak = Math.max(peak, v);
			j++;
		}
		out.push({ pos: wb / w, step: Math.sign(s) * peak });
		i = j;
	}
	return out.sort((a, b) => Math.abs(b.step) - Math.abs(a.step));
}
