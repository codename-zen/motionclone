import type { MovingProperty, Track } from "../measure/elements.ts";
import { type Property, readProperty } from "../measure/series.ts";
import type { SpecRow } from "../spec/schema.ts";

export type PairRow = Pick<
	SpecRow,
	| "id"
	| "startMs"
	| "durationMs"
	| "from"
	| "to"
	| "distanceObserved"
	| "toObserved"
>;

// Leaving a row or a clone motion unpaired costs this; a pair is kept while it costs less than leaving both.
const SKIP = 1;
// Starts this far apart cost as much as one skip.
const TIME_SCALE_MS = 1000;
// A clone motion that goes the other way costs a skip; each halving or doubling of the distance half of one.
const TURN = 1;
const PER_DOUBLING = 0.5;

/** How unlike a clone motion is to a row: start time, direction and distance. */
export function pairCost(row: PairRow, m: MovingProperty): number {
	const time = Math.abs(m.window.startMs - row.startMs) / TIME_SCALE_MS;
	const want = row.to - row.from;
	const got = m.window.change;
	const turn = Math.sign(want) !== Math.sign(got) ? TURN : 0;
	const ratio = Math.log2(
		Math.max(Math.abs(got), 1e-9) / Math.max(Math.abs(want), 1e-9),
	);
	// A lower-bound distance, or one to an end value the reference never shows, is met by any longer move.
	const off =
		row.distanceObserved === "lower-bound" || !row.toObserved
			? Math.max(0, -ratio)
			: Math.abs(ratio);
	return time + turn + PER_DOUBLING * Math.min(2, off);
}

export interface Pairing {
	/** The clone motion of each row id; absent when the row has none. */
	byRow: Map<string, MovingProperty>;
	/** Clone motions no row took, in time order. */
	extra: MovingProperty[];
}

/**
 * Rows and clone motions of one property paired in time order by the least total cost, so one motion missing on
 * either side leaves the later pairs in place instead of shifting them all.
 */
export function pairMotions(
	rows: readonly PairRow[],
	motions: readonly MovingProperty[],
): Pairing {
	const rs = [...rows].sort((a, b) => a.startMs - b.startMs);
	const ms = [...motions].sort((a, b) => a.window.startMs - b.window.startMs);
	const n = rs.length;
	const k = ms.length;
	// Least cost of the first i rows and j motions, flat at i * (k + 1) + j, and the last step that reaches it.
	const cost = new Array<number>((n + 1) * (k + 1)).fill(0);
	const step = new Array<"pair" | "row" | "motion">((n + 1) * (k + 1)).fill(
		"pair",
	);
	const at = (i: number, j: number) => i * (k + 1) + j;
	const costAt = (i: number, j: number) => cost[at(i, j)] as number;
	for (let i = 0; i <= n; i++)
		for (let j = 0; j <= k; j++) {
			if (i === 0 && j === 0) continue;
			let best = Number.POSITIVE_INFINITY;
			let how: "pair" | "row" | "motion" = "pair";
			if (i > 0 && j > 0) {
				const c = pairCost(rs[i - 1] as PairRow, ms[j - 1] as MovingProperty);
				if (c < 2 * SKIP) best = costAt(i - 1, j - 1) + c;
			}
			if (i > 0 && costAt(i - 1, j) + SKIP < best) {
				best = costAt(i - 1, j) + SKIP;
				how = "row";
			}
			if (j > 0 && costAt(i, j - 1) + SKIP < best) {
				best = costAt(i, j - 1) + SKIP;
				how = "motion";
			}
			cost[at(i, j)] = best;
			step[at(i, j)] = how;
		}
	const byRow = new Map<string, MovingProperty>();
	const extra: MovingProperty[] = [];
	let i = n;
	let j = k;
	while (i > 0 || j > 0) {
		const how = step[at(i, j)];
		if (how === "pair") {
			byRow.set((rs[i - 1] as PairRow).id, ms[j - 1] as MovingProperty);
			i--;
			j--;
		} else if (how === "row") i--;
		else {
			extra.unshift(ms[j - 1] as MovingProperty);
			j--;
		}
	}
	return { byRow, extra };
}

// The reference holds still over a clone motion when it reads most frames there and moves less than this share of it.
const STILL_SHARE = 0.25;
const COVERED = 0.8;

const GROUP: Partial<Record<Property, "opacity" | "scale" | "blur">> = {
	opacity: "opacity",
	scale: "scale",
	scaleX: "scale",
	scaleY: "scale",
	blur: "blur",
};

/**
 * The reference clearly shows the element holding still while the clone makes this motion: it reads the property
 * on most frames there, none of them filled in, repeated or cut off, and they stay within a share of the motion.
 * Where it does not (the element lost, faded or past a region edge), the reference cannot say the motion is extra.
 */
export function holdsStill(
	ref: Track,
	m: Pick<MovingProperty, "selector" | "index" | "property" | "window">,
): boolean {
	const w = m.window;
	const frames = ref.frames.filter(
		(f) => f.t >= w.startMs - ref.frameMs && f.t <= w.endMs + ref.frameMs,
	);
	const group = GROUP[m.property] ?? "position";
	const values = frames.flatMap((f) => {
		const e = f.elements[m.selector]?.find((x) => x.index === m.index);
		if (!e || e.repeated || e.observed?.[group] === false) return [];
		return [readProperty(e, m.property)];
	});
	if (values.length < Math.max(2, COVERED * frames.length)) return false;
	const range = Math.max(...values) - Math.min(...values);
	return range < STILL_SHARE * Math.abs(w.change);
}
