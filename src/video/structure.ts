import {
	BLOCK,
	type Block,
	blocksAt,
	MIN_STD,
	refine,
	type Shift,
	sumAt,
	tiles,
	vote,
} from "./block.ts";
import { COARSE, type Frame, type Rect, score, TINY, vertex } from "./match.ts";

// A block matches where its zero-mean luma correlates this well with the frame.
const MATCH_NCC = 0.8;
// Accepted when this many blocks match, and this share of the blocks that land on structure.
const MIN_MATCH = 3;
const MATCH_SHARE = 0.5;
// Quarter-resolution pixels searched around the predicted displacement, as the template search does.
const NEAR = 10;

/**
 * The content of a rigid element as blocks normalised one by one, so each block judges identity on its own
 * structure: a block that blends into the background in a frame (a white edge on a white page) drops out
 * instead of pulling the whole match down, and a page that flips around the element does not matter.
 */
export interface Structure {
	ref: Frame;
	box: Rect;
	coarse: Block[];
	full: Block[];
}

export function structureOf(ref: Frame, box: Rect): Structure | null {
	const at = tiles(box, COARSE);
	const n = BLOCK * COARSE;
	const full = blocksAt(
		ref.full,
		at.map((t) => ({ x: t.x * COARSE, y: t.y * COARSE })),
		n,
	);
	if (full.length < MIN_MATCH) return null;
	return { ref, box, coarse: blocksAt(ref.coarse, at, BLOCK), full };
}

/** Sub-pixel peak of the summed block correlation on each axis. */
function subPixel(f: Frame, blocks: Block[], d: Shift): Shift {
	const at = (x: number, y: number) => sumAt(f.full, blocks, x, y);
	const c = at(d.x, d.y);
	return {
		x: d.x + vertex(at(d.x - 1, d.y), c, at(d.x + 1, d.y)),
		y: d.y + vertex(at(d.x, d.y - 1), c, at(d.x, d.y + 1)),
	};
}

/** The displacement near a quarter-resolution guess, refined at full resolution, if enough blocks match there. */
function confirm(
	st: Structure,
	f: Frame,
	guess: Shift,
	radius: number,
): { dx: number; dy: number; quality: number } | null {
	const c = refine(f.coarse, st.coarse, guess, radius);
	const d = refine(
		f.full,
		st.full,
		{ x: c.x * COARSE, y: c.y * COARSE },
		COARSE,
	);
	let seen = 0;
	let matched = 0;
	for (const k of st.full) {
		const s = score(f.full, k.g, k.x + d.x, k.y + d.y);
		if (!s || s.spread < MIN_STD) continue;
		seen++;
		if (s.ncc >= MATCH_NCC) matched++;
	}
	if (matched < MIN_MATCH || matched < MATCH_SHARE * seen) return null;
	const p = subPixel(f, st.full, d);
	return { dx: p.x, dy: p.y, quality: matched / seen };
}

/**
 * Where the element's blocks moved since the reference frame: near the predicted displacement first, else where
 * they vote at eighth resolution inside `area`; the displacement is refined at quarter and full resolution, and
 * accepted when enough blocks match there. Blocks that land on flat frame content say nothing either way.
 * Quality is the share of the others that match.
 */
export function matchStructure(
	st: Structure,
	f: Frame,
	area: Rect,
	predicted: Shift,
): { dx: number; dy: number; quality: number } | null {
	const near = confirm(
		st,
		f,
		{
			x: Math.round(predicted.x / COARSE),
			y: Math.round(predicted.y / COARSE),
		},
		NEAR,
	);
	if (near) return near;
	const v = vote(st.ref.tiny, f.tiny, st.box, area, true);
	if (!v) return null;
	const scale = TINY / COARSE;
	return confirm(st, f, { x: v.x * scale, y: v.y * scale }, scale + 1);
}
