import { downsample, type Plane, readLuma } from "./luma.ts";
import { COARSE, type Rect } from "./match.ts";

// A frame is still when at most this share of quarter-resolution pixels changed by more than the noise floor.
const STILL_SHARE = 0.002;
// Two rest frames show different states when more than this share of pixels differs.
const STATE_SHARE = 0.01;
/** Consecutive still frames that make a rest plateau. */
export const PLATEAU_FRAMES = 5;

/** Quarter-resolution luma of every frame, rounded to bytes, plus the full-resolution end frames. */
export interface Scan {
	frames: number;
	width: number;
	height: number;
	coarse: Uint8Array[];
	first: Plane;
	last: Plane;
}

export interface Plateau {
	from: number;
	to: number;
	/** The frame that stands for the plateau: the clip end it holds, else its middle. */
	k: number;
}

/** Read every frame once; `visit` sees each full-resolution plane in order. */
export async function scanClip(
	dir: string,
	frames: number,
	visit?: (k: number, p: Plane) => void,
): Promise<Scan> {
	const coarse: Uint8Array[] = [];
	let first: Plane | null = null;
	let last: Plane | null = null;
	let size = { width: 0, height: 0 };
	for (let k = 0; k < frames; k++) {
		const p = await readLuma(dir, k);
		visit?.(k, p);
		const c = downsample(p, COARSE);
		size = { width: c.width, height: c.height };
		coarse.push(Uint8Array.from(c.data, (v) => Math.round(v)));
		if (k === 0) first = p;
		last = p;
	}
	return {
		frames,
		...size,
		coarse,
		first: first as Plane,
		last: last as Plane,
	};
}

/** The rect in quarter-resolution pixels, inside the plane. */
function coarseRect(s: Scan, r: Rect): Rect {
	const x = Math.max(0, Math.floor(r.x / COARSE));
	const y = Math.max(0, Math.floor(r.y / COARSE));
	return {
		x,
		y,
		w: Math.max(1, Math.min(s.width, Math.ceil((r.x + r.w) / COARSE)) - x),
		h: Math.max(1, Math.min(s.height, Math.ceil((r.y + r.h) / COARSE)) - y),
	};
}

/** Share of the rect's quarter-resolution pixels that differ by more than the floor between frames a and b. */
export function changedShare(
	s: Scan,
	a: number,
	b: number,
	r: Rect,
	floor: number,
): number {
	const c = coarseRect(s, r);
	const pa = s.coarse[a] as Uint8Array;
	const pb = s.coarse[b] as Uint8Array;
	let n = 0;
	for (let y = c.y; y < c.y + c.h; y++)
		for (let x = c.x; x < c.x + c.w; x++) {
			const o = y * s.width + x;
			if (Math.abs((pa[o] as number) - (pb[o] as number)) > floor) n++;
		}
	return n / (c.w * c.h);
}

export const sameState = (
	s: Scan,
	a: number,
	b: number,
	r: Rect,
	floor: number,
) => changedShare(s, a, b, r, floor) <= STATE_SHARE;

/** Runs of at least PLATEAU_FRAMES frames where nothing in the rect moves. */
export function restPlateaus(s: Scan, r: Rect, floor: number): Plateau[] {
	const out: Plateau[] = [];
	let from = 0;
	const close = (to: number) => {
		if (to - from + 1 >= PLATEAU_FRAMES) {
			const k = from === 0 ? 0 : to === s.frames - 1 ? to : (from + to) >> 1;
			out.push({ from, to, k });
		}
	};
	for (let k = 1; k < s.frames; k++)
		if (changedShare(s, k - 1, k, r, floor) > STILL_SHARE) {
			close(k - 1);
			from = k;
		}
	close(s.frames - 1);
	return out;
}
