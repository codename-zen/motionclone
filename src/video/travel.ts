import { BLOCK, blocksAt, MIN_VOTES, refine, tiles, vote } from "./block.ts";
import type { Plane } from "./luma.ts";
import { COARSE, type Frame, type Rect, score, TINY } from "./match.ts";

// A block moved when it matches this well at the travel and better than where it was.
const MOVED_NCC = 0.8;
const MOVED_MARGIN = 0.05;
const SURE_NCC = 0.95;
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

// A region thinner than this is searched as this thick (frame pixels), so its content still fills a voting block.
const MIN_SIDE = 1.5 * BLOCK * TINY;

/** The rect grown about its centre to MIN_SIDE on each thinner side, inside the frame. */
function thickened(r: Rect, p: Plane): Rect {
	const grow = (at: number, len: number, max: number): [number, number] => {
		if (len >= MIN_SIDE) return [at, len];
		const l = Math.min(max, MIN_SIDE);
		return [Math.max(0, Math.min(max - l, at + len / 2 - l / 2)), l];
	};
	const [x, w] = grow(r.x, r.w, p.width);
	const [y, h] = grow(r.y, r.h, p.height);
	return { x, y, w, h };
}

/**
 * Content of the rect that travels between two rest states (see travelIn); `thin` also looks for content thinner
 * than a voting block, for a region planned again from travel. A rect too thin for the voting blocks,
 * such as one drawn over a row of icons along its travel, is searched thickened, and the element box is then cut
 * back to the rect; the element must stay inside it at both states.
 */
export function findTravel(
	a: Frame,
	b: Frame,
	r: Rect,
	floor: number,
	thin = false,
): Travel | null {
	const g = thickened(r, a.full);
	const t = travelIn(a, b, g, floor, thin);
	if (!t || (g.w === r.w && g.h === r.h)) return t;
	const x = Math.max(t.box.x, r.x);
	const y = Math.max(t.box.y, r.y);
	const box = {
		x,
		y,
		w: Math.min(t.box.x + t.box.w, r.x + r.w) - x,
		h: Math.min(t.box.y + t.box.h, r.y + r.h) - y,
	};
	const moved = { ...box, x: box.x + t.dx, y: box.y + t.dy };
	if (box.w < BLOCK || box.h < BLOCK || !inside(moved, r, 0)) return null;
	return { ...t, box };
}

/**
 * Content of the rect that travels between two rest states: blocks vote for where their structure went
 * (zero-mean, normalised luma, so a background that flips around them does not matter), the displacement is
 * refined at quarter and full resolution, and the box is the moving blocks that stay inside the rect.
 */
function travelIn(
	a: Frame,
	b: Frame,
	r: Rect,
	floor: number,
	thin: boolean,
): Travel | null {
	// With `thin`, content thinner than a voting block, such as a toolbar between two panels, votes with smaller
	// blocks when no large one does.
	const v = vote(a.tiny, b.tiny, r);
	const fine =
		v || !thin ? null : vote(a.coarse, b.coarse, r, null, false, COARSE);
	if (!v && !fine) return null;
	// Thin content is classified with blocks at half-block steps too, so some lie wholly on it.
	const at = tiles(r, COARSE, v ? BLOCK : BLOCK / 2);
	const c = refine(
		b.coarse,
		blocksAt(a.coarse, at, BLOCK),
		v
			? { x: (v.x * TINY) / COARSE, y: (v.y * TINY) / COARSE }
			: (fine as { x: number; y: number }),
		v ? TINY / COARSE + 1 : 0,
	);
	const n = BLOCK * COARSE;
	const scored = blocksAt(a.coarse, at, BLOCK).flatMap((k) => {
		const ncc = score(b.coarse, k.g, k.x + c.x, k.y + c.y)?.ncc ?? -1;
		const still = Math.abs(score(b.coarse, k.g, k.x, k.y)?.ncc ?? 0);
		if (ncc < MOVED_NCC || ncc < still + MOVED_MARGIN) return [];
		return [{ x: k.x * COARSE, y: k.y * COARSE, w: n, h: n, ncc }];
	});
	const moved = scored.map(({ ncc: _, ...m }) => m);
	if (moved.length < MIN_VOTES) return null;
	// Thin content is refined on the blocks that lie wholly on it, as its neighbours change between the states.
	const sure = scored.filter((m) => m.ncc >= SURE_NCC);
	const d = refine(
		b.full,
		blocksAt(a.full, v || sure.length < MIN_VOTES ? moved : sure, n),
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
	// Kept blocks stay inside at state b; their box is held inside at state a too.
	const inner = kept.length > 0 ? overlapOf(bbox(kept), limit) : null;
	const blocks = cut ?? inner ?? bbox(leaves ? moved : kept);
	const box = fitBox(a.full, b.full, blocks, d, leaves ? r : limit, floor);
	// Content that does not look the same at both states once fitted is not one rigid element.
	if (box.w * box.h < RIGID * blocks.w * blocks.h) return null;
	return { dx: d.x, dy: d.y, box, leaves };
}
