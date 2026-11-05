import type { PNG } from "pngjs";

/**
 * A straight boundary across most of a band: the edge of a large surface, a step between two flat areas, or a thin
 * divider line beside a flat area, such as a hairline between a panel and a page of the same colour.
 */
export interface Edge {
	/** Position along the axis, frame pixels: the boundary lies just before this row (or column). */
	pos: number;
	/** Mean luma step across it, levels; the sign says which side is lighter. For a line, its contrast. */
	step: number;
	line: boolean;
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
// A divider line is at most LINE_W pixels wide and stands out from both sides by at least MIN_LINE levels, on SHARE
// of the lines: a faint hairline is as clear as a strong step when it runs straight across flat surroundings.
const LINE_W = 4;
const MIN_LINE = 6;

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

/** Runs of non-zero scores of one sign, as edges at their weighted centre, `shift` pixels on. */
function runs(score: number[], at: number, line: boolean): Edge[] {
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
			wb += v * (at + j);
			peak = Math.max(peak, v);
			j++;
		}
		out.push({ pos: wb / w, step: Math.sign(s) * peak, line });
		i = j;
	}
	return out;
}

/**
 * Every surface edge in the band on one frame, strongest step first; `minStep` lowers the step it needs. Divider
 * lines are listed after the steps.
 */
export function edgesIn(png: PNG, band: EdgeBand, minStep = MIN_STEP): Edge[] {
	const along = band.axis === "y" ? png.height : png.width;
	const across = band.axis === "y" ? png.width : png.height;
	const a0 = Math.max(0, Math.round(band.a0 + (band.a1 - band.a0) / 4));
	const a1 = Math.min(across, Math.round(band.a1 - (band.a1 - band.a0) / 4));
	const from = Math.max(0, band.b0 - SIDE - LINE_W);
	const to = Math.min(along, band.b1 + SIDE + LINE_W);
	if (a1 <= a0 || to - from < 2 * SIDE + LINE_W + 1) return [];
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
	// Steps are read from b0 to b1; lines need LINE_W more on the far side.
	const stepFrom = Math.max(0, band.b0 - SIDE) + SIDE;
	const stepTo = Math.min(along, band.b1 + SIDE) - SIDE;
	const steps: number[] = [];
	const ridges: number[] = [];
	const last = Math.max(stepTo, to - SIDE - LINE_W);
	for (let b = from + SIDE; b <= last; b++) {
		const after = lines.map((mean) => mean(b, b + SIDE));
		const before = lines.map((mean) => mean(b - SIDE, b));
		let up = 0;
		let down = 0;
		let sum = 0;
		after.forEach((v, i) => {
			const d = v - (before[i] as number);
			if (d >= minStep) up++;
			else if (d <= -minStep) down++;
			sum += d;
		});
		const edge =
			b >= stepFrom &&
			b <= stepTo &&
			(up >= need || down >= need) &&
			(flat(after) || flat(before));
		steps.push(edge ? sum / lines.length : 0);
		// A line between b and b + LINE_W against both sides, which must agree (a step is not a line).
		if (b + LINE_W + SIDE > to) {
			ridges.push(0);
			continue;
		}
		const beyond = lines.map((mean) => mean(b + LINE_W, b + LINE_W + SIDE));
		let light = 0;
		let dark = 0;
		let contrast = 0;
		lines.forEach((mean, i) => {
			const l = before[i] as number;
			const r = beyond[i] as number;
			const c = mean(b, b + LINE_W) - (l + r) / 2;
			const agree = Math.abs(l - r) <= Math.abs(c) / 2;
			if (agree && c >= MIN_LINE) light++;
			else if (agree && c <= -MIN_LINE) dark++;
			contrast += c;
		});
		const line =
			(light >= need || dark >= need) && (flat(before) || flat(beyond));
		ridges.push(line ? contrast / lines.length : 0);
	}
	const found = runs(steps, from + SIDE, false).sort(
		(a, b) => Math.abs(b.step) - Math.abs(a.step),
	);
	const thin = runs(ridges, from + SIDE + LINE_W / 2, true).filter((l) =>
		found.every((e) => Math.abs(e.pos - l.pos) > LINE_W + SIDE),
	);
	return [...found, ...thin];
}
