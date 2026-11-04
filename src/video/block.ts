import type { Plane } from "./luma.ts";
import { type Grid, gridOf, type Rect, score, TINY } from "./match.ts";

// Blocks are this many pixels square on their level: 64 frame pixels for the vote, 32 to classify.
export const BLOCK = 8;
// A block needs this luma standard deviation to say anything about where it went.
export const MIN_STD = 4;
// A block votes for its best displacement when it matches there this well.
const VOTE_NCC = 0.9;
export const MIN_VOTES = 2;

export interface Block {
	x: number;
	y: number;
	g: Grid;
}

export interface Shift {
	x: number;
	y: number;
}

export function blockAt(
	p: Plane,
	x: number,
	y: number,
	n: number,
): Grid | null {
	if (x < 0 || y < 0 || x + n > p.width || y + n > p.height) return null;
	const t = new Float32Array(n * n);
	for (let j = 0; j < n; j++)
		for (let i = 0; i < n; i++)
			t[j * n + i] = p.data[(y + j) * p.width + x + i] as number;
	const g = gridOf(t, n, n);
	return Math.sqrt(g.sumSq / (n * n)) >= MIN_STD ? g : null;
}

/** Block origins tiling the rect on a level of factor f, `step` level pixels apart. */
export function tiles(r: Rect, f: number, step = BLOCK): Shift[] {
	const out: Shift[] = [];
	const x0 = Math.ceil(r.x / f);
	const y0 = Math.ceil(r.y / f);
	for (let y = y0; (y + BLOCK) * f <= r.y + r.h; y += step)
		for (let x = x0; (x + BLOCK) * f <= r.x + r.w; x += step)
			out.push({ x, y });
	return out;
}

/** Blocks of `n` pixels with structure at the given origins of a plane. */
export const blocksAt = (p: Plane, at: Shift[], n: number) =>
	at.flatMap((t): Block[] => {
		const g = blockAt(p, t.x, t.y, n);
		return g ? [{ ...t, g }] : [];
	});

/**
 * The most voted displacement of the rect's blocks on the eighth-resolution level. Blocks search all of `b`, or
 * only `within` (frame pixels); standstill votes are excluded unless `still` is set.
 */
export function vote(
	a: Plane,
	b: Plane,
	r: Rect,
	within: Rect | null = null,
	still = false,
): Shift | null {
	const bx0 = within ? Math.max(0, Math.ceil(within.x / TINY)) : 0;
	const by0 = within ? Math.max(0, Math.ceil(within.y / TINY)) : 0;
	const bx1 = within
		? Math.min(b.width, Math.floor((within.x + within.w) / TINY))
		: b.width;
	const by1 = within
		? Math.min(b.height, Math.floor((within.y + within.h) / TINY))
		: b.height;
	const votes = new Map<string, number>();
	// Half-block steps, so content near the frame edge still has a block that fits at both states.
	for (const t of tiles(r, TINY, BLOCK / 2)) {
		const g = blockAt(a, t.x, t.y, BLOCK);
		if (!g) continue;
		let top = { ncc: VOTE_NCC, x: 0, y: 0, hit: false };
		for (let y = by0; y + BLOCK <= by1; y++)
			for (let x = bx0; x + BLOCK <= bx1; x++) {
				const s = score(b, g, x, y);
				if (s && s.ncc > top.ncc) top = { ncc: s.ncc, x, y, hit: true };
			}
		if (!top.hit) continue;
		const key = `${top.x - t.x},${top.y - t.y}`;
		votes.set(key, (votes.get(key) ?? 0) + 1);
	}
	let best: { x: number; y: number; n: number } | null = null;
	for (const key of votes.keys()) {
		const [x, y] = key.split(",").map(Number) as [number, number];
		if (!still && Math.abs(x) <= 1 && Math.abs(y) <= 1) continue;
		let n = 0;
		for (let j = -1; j <= 1; j++)
			for (let i = -1; i <= 1; i++) n += votes.get(`${x + i},${y + j}`) ?? 0;
		if (n >= MIN_VOTES && (!best || n > best.n)) best = { x, y, n };
	}
	return best;
}

/** Summed correlation of the blocks displaced by (dx, dy); a block outside the plane counts -1. */
export function sumAt(b: Plane, blocks: Block[], dx: number, dy: number) {
	let s = 0;
	for (const k of blocks) s += score(b, k.g, k.x + dx, k.y + dy)?.ncc ?? -1;
	return s;
}

/**
 * The displacement within `radius` of `d` where the blocks' summed correlation peaks. Only blocks that stay in
 * the frame over the whole window count, so the frame edge cannot pull the peak towards keeping more inside.
 */
export function refine(
	b: Plane,
	all: Block[],
	d: Shift,
	radius: number,
): Shift {
	const fits = (k: Block) =>
		k.x + d.x - radius >= 0 &&
		k.y + d.y - radius >= 0 &&
		k.x + d.x + radius + k.g.w <= b.width &&
		k.y + d.y + radius + k.g.h <= b.height;
	const blocks = all.some(fits) ? all.filter(fits) : all;
	let top = { ...d, s: Number.NEGATIVE_INFINITY };
	for (let j = -radius; j <= radius; j++)
		for (let i = -radius; i <= radius; i++) {
			const s = sumAt(b, blocks, d.x + i, d.y + j);
			if (s > top.s) top = { x: d.x + i, y: d.y + j, s };
		}
	return { x: top.x, y: top.y };
}
