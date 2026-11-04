import type { Activity } from "./activity.ts";
import type { PixelRect } from "./options.ts";

// Luma step from the screen to what lies outside it, on the mean frame.
const EDGE = 10;
// Spread allowed inside the still strip outside the edge.
const UNIFORM = 6;
const STRIP = 4;
// Share of the edge's length that must pass; the rest absorbs rounded corners and notches.
const PASS = 0.75;
const SAME_COLOUR = 16;
const MIN_SIZE = 48;

export type Side = "left" | "right" | "top" | "bottom";
const SIDES: Side[] = ["left", "right", "top", "bottom"];

interface Candidate {
	/** Left and top: the first screen pixel; right and bottom: one past the last. */
	at: number;
	/** Mean luma just outside the edge: the bezel or the background. */
	colour: number;
}

interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export interface Screen {
	rect: PixelRect;
	/** Sides bounded by a bezel or background edge; the others run to the frame edge. */
	edges: Side[];
	/** Where the motion is, in video pixels. */
	motion: PixelRect;
	/** Share of the moving pixels inside the rect. */
	motionInside: number;
	confident: boolean;
}

const moving = (a: Activity, i: number) => (a.moves[i] as number) >= 2;

function spread(weights: Float64Array, total: number): [number, number] {
	let acc = 0;
	let lo = 0;
	let hi = weights.length;
	for (let i = 0; i < weights.length; i++) {
		const next = acc + (weights[i] as number);
		if (acc <= 0.005 * total && next > 0.005 * total) lo = i;
		if (acc < 0.995 * total && next >= 0.995 * total) hi = i + 1;
		acc = next;
	}
	return [lo, hi];
}

/** The box holding 99 % of the moving pixels, so a stray changing pixel elsewhere does not stretch it. */
function motionBox(a: Activity): { box: Box; total: number } | null {
	const cols = new Float64Array(a.width);
	const rows = new Float64Array(a.height);
	let total = 0;
	for (let y = 0; y < a.height; y++)
		for (let x = 0; x < a.width; x++)
			if (moving(a, y * a.width + x)) {
				cols[x] = (cols[x] as number) + 1;
				rows[y] = (rows[y] as number) + 1;
				total++;
			}
	if (total < 64) return null;
	const [x0, x1] = spread(cols, total);
	const [y0, y1] = spread(rows, total);
	return { box: { x0, y0, x1, y1 }, total };
}

const median = (v: number[]) => {
	const s = [...v].sort((p, q) => p - q);
	return s[Math.floor(s.length / 2)] ?? 0;
};

/** Straight edges outward from `start` with a still, uniform strip outside them, innermost first. */
function candidates(
	a: Activity,
	side: Side,
	start: number,
	lo: number,
	hi: number,
): Candidate[] {
	const vertical = side === "left" || side === "right";
	const dir = side === "left" || side === "top" ? -1 : 1;
	const limit = vertical ? a.width : a.height;
	const at = (u: number, v: number) =>
		a.mean[vertical ? v * a.width + u : u * a.width + v] as number;
	const still = (u: number, v: number) =>
		(a.moves[vertical ? v * a.width + u : u * a.width + v] as number) <=
		Math.max(1, Math.floor(a.frames * 0.01));
	const along: number[] = [];
	for (
		let v = Math.max(0, lo);
		v < Math.min(hi, vertical ? a.height : a.width);
		v++
	)
		along.push(v);
	if (along.length === 0) return [];
	const inRange = (u: number) => u >= 0 && u < limit;
	const out: Candidate[] = [];
	for (
		let b = start;
		inRange(b - dir) && inRange(b + dir * (STRIP + 1)) && out.length < 4;
		b += dir
	) {
		const refs = along.map((v) => at(b + 2 * dir, v));
		const colour = median(refs);
		let pass = 0;
		for (const [j, v] of along.entries()) {
			const ref = refs[j] as number;
			if (Math.abs(ref - colour) > 2 * UNIFORM) continue;
			const inside = (at(b, v) + at(b - dir, v)) / 2;
			if (Math.abs(inside - ref) < EDGE) continue;
			let ok = true;
			for (let k = 2; k <= STRIP + 1 && ok; k++) {
				const u = b + dir * k;
				ok = Math.abs(at(u, v) - ref) <= UNIFORM && still(u, v);
			}
			if (ok) pass++;
		}
		if (pass < PASS * along.length) continue;
		let best = b;
		let bestStep = -1;
		for (const c of [b - dir, b, b + dir]) {
			let step = 0;
			for (const v of along) step += Math.abs(at(c, v) - at(c + dir, v));
			if (step > bestStep) [best, bestStep] = [c, step];
		}
		out.push({ at: dir < 0 ? best : best + 1, colour });
		b = best + dir * (STRIP + 2);
	}
	return out;
}

/** Per side, the innermost edge whose outside colour another side shares (the bezel ring), else the innermost. */
function choose(
	found: Record<Side, Candidate[]>,
): Record<Side, Candidate | undefined> {
	const pick = (side: Side) => {
		const others = SIDES.filter((s) => s !== side).flatMap((s) =>
			found[s].map((c) => c.colour),
		);
		return (
			found[side].find((c) =>
				others.some((o) => Math.abs(o - c.colour) <= SAME_COLOUR),
			) ?? found[side][0]
		);
	};
	return {
		left: pick("left"),
		right: pick("right"),
		top: pick("top"),
		bottom: pick("bottom"),
	};
}

const inset = (lo: number, hi: number): [number, number] => {
	const pad = Math.floor((hi - lo) * 0.15);
	return [lo + pad, hi - pad];
};

/**
 * The device screen in a recording: the rectangle around the motion bounded by straight edges with a still,
 * uniform bezel or background outside them. Sides without such an edge run to the frame edge.
 */
export function findScreen(a: Activity): Screen | null {
	const m = motionBox(a);
	if (!m) return null;
	const { box: mb, total } = m;
	const mid = (lo: number, hi: number) => Math.floor((lo + hi) / 2);
	const start = {
		left: Math.min(mb.x0 + 4, mid(mb.x0, mb.x1)),
		right: Math.max(mb.x1 - 5, mid(mb.x0, mb.x1)),
		top: Math.min(mb.y0 + 4, mid(mb.y0, mb.y1)),
		bottom: Math.max(mb.y1 - 5, mid(mb.y0, mb.y1)),
	};
	const found: Record<Side, Candidate[]> = {
		left: [],
		right: [],
		top: [],
		bottom: [],
	};
	const box = { ...mb };
	let picks = choose(found);
	for (let round = 0; round < 2; round++) {
		const [ylo, yhi] = inset(box.y0, box.y1);
		found.left = candidates(a, "left", start.left, ylo, yhi);
		found.right = candidates(a, "right", start.right, ylo, yhi);
		picks = choose(found);
		box.x0 = picks.left?.at ?? 0;
		box.x1 = picks.right?.at ?? a.width;
		const [xlo, xhi] = inset(box.x0, box.x1);
		found.top = candidates(a, "top", start.top, xlo, xhi);
		found.bottom = candidates(a, "bottom", start.bottom, xlo, xhi);
		picks = choose(found);
		box.y0 = picks.top?.at ?? 0;
		box.y1 = picks.bottom?.at ?? a.height;
	}
	const edges = SIDES.filter((s) => picks[s]);
	let inside = 0;
	for (let y = box.y0; y < box.y1; y++)
		for (let x = box.x0; x < box.x1; x++)
			if (moving(a, y * a.width + x)) inside++;
	const colours = edges.map((s) => (picks[s] as Candidate).colour);
	const ring = colours.some((c, i) =>
		colours.some((o, j) => j !== i && Math.abs(o - c) <= SAME_COLOUR),
	);
	const motionInside = inside / total;
	const w = box.x1 - box.x0;
	const h = box.y1 - box.y0;
	return {
		rect: { x: box.x0, y: box.y0, w, h },
		edges,
		motion: { x: mb.x0, y: mb.y0, w: mb.x1 - mb.x0, h: mb.y1 - mb.y0 },
		motionInside,
		confident:
			ring &&
			Boolean((picks.left && picks.right) || (picks.top && picks.bottom)) &&
			motionInside >= 0.9 &&
			w >= MIN_SIZE &&
			h >= MIN_SIZE,
	};
}
