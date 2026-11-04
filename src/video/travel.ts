import type { Plane } from "./luma.ts";
import {
	COARSE,
	type Frame,
	type Grid,
	gridOf,
	type Rect,
	score,
	TINY,
} from "./match.ts";

// Blocks are this many pixels square on their level: 64 frame pixels for the vote, 32 to classify.
const BLOCK = 8;
// A block needs this luma standard deviation to say anything about where it went.
const MIN_STD = 4;
// A block votes for its best displacement when it matches there this well.
const VOTE_NCC = 0.9;
const MIN_VOTES = 2;
// A block moved when it matches this well at the travel and better than where it was.
const MOVED_NCC = 0.8;
const MOVED_MARGIN = 0.05;
// Kept blocks stay this far inside the region at both rest states.
const EDGE = 8;
// The fitted box keeps at least this share of the moving blocks' box.
const RIGID = 0.5;
// A box row or column belongs to the element when this share of its pixels agrees at both states.
const AGREE_SHARE = 0.9;

export interface Travel {
	/** Displacement from state a to state b, frame pixels. */
	dx: number;
	dy: number;
	/** The moving element at state a: content that is inside the region at both states. */
	box: Rect;
	/** No moving content stays inside the region at both states; the box is what is inside at a. */
	leaves: boolean;
}

function blockAt(p: Plane, x: number, y: number, n: number): Grid | null {
	if (x < 0 || y < 0 || x + n > p.width || y + n > p.height) return null;
	const t = new Float32Array(n * n);
	for (let j = 0; j < n; j++)
		for (let i = 0; i < n; i++)
			t[j * n + i] = p.data[(y + j) * p.width + x + i] as number;
	const g = gridOf(t, n, n);
	return Math.sqrt(g.sumSq / (n * n)) >= MIN_STD ? g : null;
}

/** Block origins tiling the rect on a level of factor f, `step` level pixels apart. */
function tiles(r: Rect, f: number, step = BLOCK): { x: number; y: number }[] {
	const out: { x: number; y: number }[] = [];
	const x0 = Math.ceil(r.x / f);
	const y0 = Math.ceil(r.y / f);
	for (let y = y0; (y + BLOCK) * f <= r.y + r.h; y += step)
		for (let x = x0; (x + BLOCK) * f <= r.x + r.w; x += step)
			out.push({ x, y });
	return out;
}

/** The most voted displacement of the rect's blocks on the eighth-resolution level, static votes excluded. */
function vote(a: Plane, b: Plane, r: Rect): { x: number; y: number } | null {
	const votes = new Map<string, number>();
	// Half-block steps, so content near the frame edge still has a block that fits at both states.
	for (const t of tiles(r, TINY, BLOCK / 2)) {
		const g = blockAt(a, t.x, t.y, BLOCK);
		if (!g) continue;
		let top = { ncc: VOTE_NCC, x: 0, y: 0, hit: false };
		for (let y = 0; y + BLOCK <= b.height; y++)
			for (let x = 0; x + BLOCK <= b.width; x++) {
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
		if (Math.abs(x) <= 1 && Math.abs(y) <= 1) continue;
		let n = 0;
		for (let j = -1; j <= 1; j++)
			for (let i = -1; i <= 1; i++) n += votes.get(`${x + i},${y + j}`) ?? 0;
		if (n >= MIN_VOTES && (!best || n > best.n)) best = { x, y, n };
	}
	return best;
}

interface Block {
	x: number;
	y: number;
	g: Grid;
}

/** Blocks of `n` pixels with structure at the given origins of a plane. */
const blocksAt = (p: Plane, at: { x: number; y: number }[], n: number) =>
	at.flatMap((t): Block[] => {
		const g = blockAt(p, t.x, t.y, n);
		return g ? [{ ...t, g }] : [];
	});

/**
 * The displacement within `radius` of `d` where the blocks' summed correlation peaks. Only blocks that stay in
 * the frame over the whole window count, so the frame edge cannot pull the peak towards keeping more inside.
 */
function refine(
	b: Plane,
	all: Block[],
	d: { x: number; y: number },
	radius: number,
): { x: number; y: number } {
	const fits = (k: Block) =>
		k.x + d.x - radius >= 0 &&
		k.y + d.y - radius >= 0 &&
		k.x + d.x + radius + k.g.w <= b.width &&
		k.y + d.y + radius + k.g.h <= b.height;
	const blocks = all.some(fits) ? all.filter(fits) : all;
	let top = { ...d, s: Number.NEGATIVE_INFINITY };
	for (let j = -radius; j <= radius; j++)
		for (let i = -radius; i <= radius; i++) {
			let s = 0;
			for (const k of blocks)
				s += score(b, k.g, k.x + d.x + i, k.y + d.y + j)?.ncc ?? -1;
			if (s > top.s) top = { x: d.x + i, y: d.y + j, s };
		}
	return { x: top.x, y: top.y };
}

const inside = (b: Rect, r: Rect, m: number) =>
	b.x >= r.x + m &&
	b.y >= r.y + m &&
	b.x + b.w <= r.x + r.w - m &&
	b.y + b.h <= r.y + r.h - m;

function bbox(rs: Rect[]): Rect {
	const x0 = Math.min(...rs.map((b) => b.x));
	const y0 = Math.min(...rs.map((b) => b.y));
	const x1 = Math.max(...rs.map((b) => b.x + b.w));
	const y1 = Math.max(...rs.map((b) => b.y + b.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Fit the box to the content that looks the same at both states: grow each side by up to one block while
 * its edge row or column agrees and stays within `limit`, then trim edges that do not agree.
 */
function fitBox(
	a: Plane,
	b: Plane,
	box: Rect,
	d: { x: number; y: number },
	limit: Rect,
	floor: number,
): Rect {
	const diff = (x: number, y: number) => {
		const bx = x + d.x;
		const by = y + d.y;
		if (bx < 0 || by < 0 || bx >= b.width || by >= b.height)
			return Number.POSITIVE_INFINITY;
		return Math.abs(
			(a.data[y * a.width + x] as number) -
				(b.data[by * b.width + bx] as number),
		);
	};
	// A line agrees when most of its pixels do and their mean change stays within the floor, so a few strong
	// differences, such as rounded corners over a background that flips, are trimmed too.
	const line = (fixed: number, from: number, to: number, isRow: boolean) => {
		let n = 0;
		let sum = 0;
		for (let i = from; i < to; i++) {
			const v = isRow ? diff(i, fixed) : diff(fixed, i);
			n += v <= 2 * floor ? 1 : 0;
			sum += v;
		}
		return n >= AGREE_SHARE * (to - from) && sum <= floor * (to - from);
	};
	let [x0, y0, x1, y1] = [box.x, box.y, box.x + box.w, box.y + box.h];
	const grow = BLOCK * COARSE;
	for (let i = 0; i < grow && y0 > limit.y && line(y0 - 1, x0, x1, true); i++)
		y0--;
	for (
		let i = 0;
		i < grow && y1 < limit.y + limit.h && line(y1, x0, x1, true);
		i++
	)
		y1++;
	for (let i = 0; i < grow && x0 > limit.x && line(x0 - 1, y0, y1, false); i++)
		x0--;
	for (
		let i = 0;
		i < grow && x1 < limit.x + limit.w && line(x1, y0, y1, false);
		i++
	)
		x1++;
	while (y1 - y0 > BLOCK && !line(y0, x0, x1, true)) y0++;
	while (y1 - y0 > BLOCK && !line(y1 - 1, x0, x1, true)) y1--;
	while (x1 - x0 > BLOCK && !line(x0, y0, y1, false)) x0++;
	while (x1 - x0 > BLOCK && !line(x1 - 1, y0, y1, false)) x1--;
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** True when every side the content moves towards is a frame edge. */
const leavesByFrame = (r: Rect, d: { x: number; y: number }, p: Plane) =>
	(d.x <= 0 || r.x + r.w >= p.width) &&
	(d.x >= 0 || r.x <= 0) &&
	(d.y <= 0 || r.y + r.h >= p.height) &&
	(d.y >= 0 || r.y <= 0);

/** The overlap of two rects, or null when it is under a block on either side. */
function overlapOf(a: Rect, b: Rect): Rect | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const w = Math.min(a.x + a.w, b.x + b.w) - x;
	const h = Math.min(a.y + a.h, b.y + b.h) - y;
	return w >= BLOCK && h >= BLOCK ? { x, y, w, h } : null;
}

/** The part of the rect, shrunk by `m`, where a box stays inside at both states. */
function limitOf(r: Rect, d: { x: number; y: number }, m: number): Rect {
	const x0 = Math.max(r.x + m, r.x + m - d.x);
	const y0 = Math.max(r.y + m, r.y + m - d.y);
	const x1 = Math.min(r.x + r.w - m, r.x + r.w - m - d.x);
	const y1 = Math.min(r.y + r.h - m, r.y + r.h - m - d.y);
	return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Content of the rect that travels between two rest states: blocks vote for where their structure went
 * (zero-mean, normalised luma, so a background that flips around them does not matter), the displacement is
 * refined at quarter and full resolution, and the box is the moving blocks that stay inside the rect.
 */
export function findTravel(
	a: Frame,
	b: Frame,
	r: Rect,
	floor: number,
): Travel | null {
	const v = vote(a.tiny, b.tiny, r);
	if (!v) return null;
	const c = refine(
		b.coarse,
		blocksAt(a.coarse, tiles(r, COARSE), BLOCK),
		{ x: (v.x * TINY) / COARSE, y: (v.y * TINY) / COARSE },
		TINY / COARSE + 1,
	);
	const n = BLOCK * COARSE;
	const moved = blocksAt(a.coarse, tiles(r, COARSE), BLOCK).flatMap((k) => {
		const at = score(b.coarse, k.g, k.x + c.x, k.y + c.y)?.ncc ?? -1;
		const still = Math.abs(score(b.coarse, k.g, k.x, k.y)?.ncc ?? 0);
		if (at < MOVED_NCC || at < still + MOVED_MARGIN) return [];
		return [{ x: k.x * COARSE, y: k.y * COARSE, w: n, h: n }];
	});
	if (moved.length < MIN_VOTES) return null;
	const d = refine(
		b.full,
		blocksAt(a.full, moved, n),
		{ x: c.x * COARSE, y: c.y * COARSE },
		COARSE,
	);
	const kept = moved.filter((m) =>
		inside({ ...m, x: m.x + d.x, y: m.y + d.y }, r, EDGE),
	);
	const limit = limitOf(r, d, EDGE);
	// Content that leaves only through the frame edge is larger than the frame: keep its part that stays in view.
	const cut =
		kept.length === 0 && leavesByFrame(r, d, a.full)
			? overlapOf(bbox(moved), limit)
			: null;
	const leaves = kept.length === 0 && cut === null;
	const blocks = cut ?? bbox(leaves ? moved : kept);
	const box = fitBox(a.full, b.full, blocks, d, leaves ? r : limit, floor);
	// Content that does not look the same at both states once fitted is not one rigid element.
	if (box.w * box.h < RIGID * blocks.w * blocks.h) return null;
	return { dx: d.x, dy: d.y, box, leaves };
}
