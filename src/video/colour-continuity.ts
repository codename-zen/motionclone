import { type ColourModel, poseOf, readColour } from "./colour.ts";
import { readFrame } from "./luma.ts";

// Frames in a row the element may go unread (a frame of heavy motion blur, a cursor passing over it).
const MAX_GAP = 2;
// Per frame between readings: change of scale (log units) and of the box centre as a share of the box.
const MAX_SCALE_STEP = 0.2;
const MAX_MOVE_SHARE = 0.5;

/**
 * Whether a persistent element stays visible and connected from one end to the other: its colour box reads on
 * every frame in between, gaps of up to MAX_GAP frames aside, and moves or grows in steps a real element takes.
 * A small thumbnail that fades out before a large artwork in the same colours fades in fails here.
 */
export async function continuous(
	m: ColourModel,
	dir: string,
	from: number,
	to: number,
): Promise<boolean> {
	const step = to > from ? 1 : -1;
	let prev = {
		k: from,
		s: 1,
		x: m.box.x + m.box.w / 2,
		y: m.box.y + m.box.h / 2,
	};
	for (let k = from + step; k !== to + step; k += step) {
		const r = readColour(m, (await readFrame(dir, k)).rgba);
		const n = Math.abs(k - prev.k);
		if (!r) {
			if (n > MAX_GAP) return false;
			continue;
		}
		const p = poseOf(m, r);
		const size = Math.max(m.box.w, m.box.h) * Math.max(p.s, prev.s);
		if (
			Math.abs(Math.log(p.s / prev.s)) > MAX_SCALE_STEP * n ||
			Math.hypot(p.x - prev.x, p.y - prev.y) > MAX_MOVE_SHARE * size * n
		)
			return false;
		prev = { k, ...p };
	}
	return prev.k === to;
}
