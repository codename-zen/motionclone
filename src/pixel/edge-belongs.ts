export type Box = { x: number; y: number; w: number; h: number };
export const lead = (b: Box, axis: "x" | "y") => (axis === "y" ? b.y : b.x);
export const size = (b: Box, axis: "x" | "y") => (axis === "y" ? b.h : b.w);

// A surface edge travels between half and twice as far as the element it carries, in step with it.
const MIN_REACH = 0.5;
const MIN_CORRELATION = 0.9;
// A sweeping edge crosses at least this share of the element's size, and lies across the element, give or take
// SLACK CSS px, on this share of the frames where it moves (by more than STILL CSS px).
const SWEEP_REACH = 0.5;
const SWEEP_SHARE = 0.75;
const SLACK = 3;
const STILL = 0.25;
const MIN_FRAMES = 3;

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];

// An edge that keeps its offset to the element within this (CSS px, or share of the travel) rides on it rigidly.
const RIGID_PX = 3;
const RIGID_SHARE = 0.05;
// The first readings after the follower starts again are picks of the nearest edge, not yet followed.
const FRESH = 2;

/**
 * The edge keeps its offset to the element on every stretch the follower kept (readings at most `stale` frames
 * apart), past the first picks of each: a line of the content, or several, each picked up after the last one
 * scrolled away. Without such a stretch, over all readings.
 */
export function ridesRigidly(
	seen: readonly { k: number; offset: number }[],
	travel: number,
	stale: number,
): boolean {
	const runs: { k: number; offset: number }[][] = [];
	for (const s of seen) {
		const run = runs.at(-1);
		const last = run?.at(-1);
		if (run && last && s.k - last.k <= stale) run.push(s);
		else runs.push([s]);
	}
	const followed = runs
		.map((r) => r.slice(FRESH))
		.filter((r) => r.length >= MIN_FRAMES);
	const spread = (r: readonly { offset: number }[]) =>
		Math.max(...r.map((s) => s.offset)) - Math.min(...r.map((s) => s.offset));
	const tol = Math.max(RIGID_PX, RIGID_SHARE * travel);
	return followed.length > 0
		? followed.every((r) => spread(r) <= tol)
		: spread(seen) <= tol;
}

/**
 * The edge belongs to the element's surface: it travels about as far as the element, and with it (the positions
 * correlate), rather than being another edge the nearest-edge choice happened to land on.
 */
export function carried(
	seen: { k: number }[],
	leads: readonly (number | null)[],
	edges: readonly (number | null)[],
	travel: number,
): boolean {
	const e = seen.map((s) => edges[s.k] as number);
	const l = seen.map((s) => leads[s.k] as number);
	const reach = Math.max(...e) - Math.min(...e);
	if (reach < MIN_REACH * travel || reach > travel / MIN_REACH) return false;
	const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
	const me = mean(e);
	const ml = mean(l);
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	e.forEach((v, i) => {
		const dx = v - me;
		const dy = (l[i] as number) - ml;
		sxy += dx * dy;
		sxx += dx * dx;
		syy += dy * dy;
	});
	return sxx > 0 && syy > 0 && sxy / Math.sqrt(sxx * syy) >= MIN_CORRELATION;
}

/**
 * The edge sweeps across the element while the element stays nearly in place: a panel that reveals or covers its
 * content. It travels at least twice as far as the element and over half its size, and where it moves it lies
 * across the element's box.
 */
export function sweeps(
	seen: { k: number }[],
	boxes: readonly (Box | null)[],
	edges: readonly (number | null)[],
	axis: "x" | "y",
	travel: number,
): boolean {
	const e = seen.map((s) => edges[s.k] as number);
	const reach = Math.max(...e) - Math.min(...e);
	const sizes = boxes.flatMap((b) => (b ? [size(b, axis)] : []));
	if (reach < travel / MIN_REACH || reach < SWEEP_REACH * (median(sizes) ?? 0))
		return false;
	const moving = seen.filter(
		(_, i) =>
			i > 0 && Math.abs((e[i] as number) - (e[i - 1] as number)) > STILL,
	);
	const across = moving.filter((s) => {
		const b = boxes[s.k] as Box;
		const p = edges[s.k] as number;
		return (
			p >= lead(b, axis) - SLACK && p <= lead(b, axis) + size(b, axis) + SLACK
		);
	});
	return (
		moving.length >= MIN_FRAMES && across.length >= SWEEP_SHARE * moving.length
	);
}
