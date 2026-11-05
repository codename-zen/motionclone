import type { Series } from "./series.ts";

/** A hold this long between two motions makes them separate motions; shorter holds stay inside one. */
export const REST_MS = 250;
const REST_FRAMES = 3;
// A rest may wobble by this share of the series' range: tracker jitter, not motion.
const REST_SHARE = 0.03;
// A motion between rests must cover this share of the series' range, or travel this many rest tolerances from one
// rest to the next (half as many into or out of a gap without readings); smaller swings are reading wobble.
const MOTION_SHARE = 0.25;
const NET_RESTS = 4;
const GAP_RESTS = 2;

/** Index ranges [first, last] where the value stays within `tol` for at least REST_MS and REST_FRAMES. */
function restRuns(series: Series, tol: number): [number, number][] {
	const runs: [number, number][] = [];
	let i = 0;
	while (i < series.length) {
		let lo = (series[i] as Series[number])[1];
		let hi = lo;
		let j = i;
		while (j + 1 < series.length) {
			const v = (series[j + 1] as Series[number])[1];
			if (Math.max(hi, v) - Math.min(lo, v) > tol) break;
			lo = Math.min(lo, v);
			hi = Math.max(hi, v);
			j++;
		}
		const ms =
			(series[j] as Series[number])[0] - (series[i] as Series[number])[0];
		if (j - i + 1 >= REST_FRAMES && ms >= REST_MS) {
			runs.push([i, j]);
			i = j + 1;
		} else i++;
	}
	return runs;
}

/** The part of a rest that holds its value: a rest may begin in the tail of the motion before it, or end in the start of the next. */
function core(
	series: Series,
	[a, b]: [number, number],
	minRange: number,
): [number, number] {
	const v = (k: number) => (series[k] as Series[number])[1];
	const sorted = series
		.slice(a, b + 1)
		.map((p) => p[1])
		.sort((x, y) => x - y);
	const median = sorted[sorted.length >> 1] as number;
	let from = a;
	let to = b;
	while (from < to && Math.abs(v(from) - median) > minRange) from++;
	while (to > from && Math.abs(v(to) - median) > minRange) to--;
	return [from, to];
}

const rangeOf = (s: Series) => {
	const v = s.map((p) => p[1]);
	return Math.max(...v) - Math.min(...v);
};

/** Pieces of the series on either side of time gaps longer than REST_MS and three frames: frames with no reading. */
function splitAtGaps(series: Series): Series[] {
	const gaps = series
		.slice(1)
		.map((p, i) => p[0] - (series[i] as Series[number])[0]);
	const frame = [...gaps].sort((a, b) => a - b)[gaps.length >> 1] ?? 0;
	const limit = Math.max(REST_MS, 3 * frame);
	const out: Series[] = [[]];
	series.forEach((p, i) => {
		if (i > 0 && (gaps[i - 1] as number) > limit) out.push([]);
		(out.at(-1) as Series).push(p);
	});
	return out;
}

const netOf = (s: Series) => Math.abs((s.at(-1)?.[1] ?? 0) - (s[0]?.[1] ?? 0));

/**
 * The series cut into one piece per motion, at rests of at least REST_MS and at gaps without readings that long;
 * each piece runs from the start of the rest before its motion to the end of the rest after it. A series with one
 * motion comes back whole, unless a swing too small to keep was cut off it. A piece that runs into or out of a gap
 * is the element leaving or entering what the tracker sees, so it needs less travel.
 */
export function splitAtRests(series: Series, minRange: number): Series[] {
	const total = rangeOf(series);
	const floor = Math.max(minRange, MOTION_SHARE * total);
	const tol = Math.max(minRange, REST_SHARE * total);
	const parts = splitAtGaps(series);
	const moving: Series[] = [];
	let swung = false;
	parts.forEach((part, i) => {
		const cut = piecesOf(part, tol, minRange);
		cut.forEach((p, j) => {
			const atGap =
				(i > 0 && j === 0) || (i < parts.length - 1 && j === cut.length - 1);
			const net = (atGap ? GAP_RESTS : NET_RESTS) * tol;
			if (p.length >= 2 && (rangeOf(p) >= floor || netOf(p) >= net))
				moving.push(p);
			else if (rangeOf(p) > tol) swung = true;
		});
	});
	return moving.length > 1 || (moving.length === 1 && swung)
		? moving
		: [series];
}

/** The part cut at its rests (within `tol`) into one piece per stretch between them; whole without rests. */
function piecesOf(series: Series, tol: number, minRange: number): Series[] {
	if (series.length < 2) return [series];
	const rests = restRuns(series, tol);
	const last = series.length - 1;
	const bounds: [number, number][] = [];
	let start = 0;
	let end = -1;
	for (const rest of rests) {
		const [a, b] = core(series, rest, minRange);
		if (rest[0] > 0) bounds.push([start, b]);
		start = a;
		end = rest[1];
	}
	if (end < last) bounds.push([start, last]);
	return bounds.map(([a, b]) => series.slice(a, b + 1));
}

// A step this close to the rest value, as a share of the piece's amplitude, is still the rest.
const AT_REST = 0.1;

/**
 * A piece that jumps from its rest to its far value in one frame and eases back to the rest is a set, then a motion
 * (an element placed off its end and animated in): it starts at the far value. Other pieces come back unchanged.
 */
export function afterSnap(piece: Series): Series {
	const from = piece[0]?.[1] ?? 0;
	let k = 0;
	piece.forEach(([, v], i) => {
		if (Math.abs(v - from) > Math.abs((piece[k] as Series[number])[1] - from))
			k = i;
	});
	const amp = Math.abs((piece[k] as Series[number])[1] - from);
	if (k < 1 || amp === 0) return piece;
	const before = (piece[k - 1] as Series[number])[1];
	const end = (piece.at(-1) as Series[number])[1];
	const near = (v: number) => Math.abs(v - from) <= AT_REST * amp;
	return near(before) && near(end) ? piece.slice(k) : piece;
}
