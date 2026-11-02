import type { ClipRect } from "../capture/options.ts";
import type { TrackedElement } from "../capture/types.ts";
import type { Track } from "../measure/elements.ts";
import { blurPx } from "../measure/style.ts";
import { elementKey } from "../spec/motion.ts";
import { readPng } from "./pixels.ts";

interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export interface ActivityInput {
	dir: string;
	track: Track;
	clip: ClipRect;
	/** Element keys whose rows explain change between frame i-1 and frame i, per frame i. */
	explained: (i: number) => Set<string>;
	/** Smallest channel difference that counts as a changed pixel. */
	pixelDiff: number;
}

export interface Activity {
	/** Frame times; entry i is the change from frame i-1 to frame i (0 at i = 0). */
	t: number[];
	/** Unexplained changed area in CSS px squared, per tracked element key and frame. */
	elements: Map<string, number[]>;
	/** Unexplained changed area outside every tracked element, per frame. */
	untracked: number[];
	/** Bounding box of untracked change per frame, in CSS px relative to the clip. */
	untrackedBox: (Rect | null)[];
	/** Box area in CSS px squared per element key, largest seen. */
	areas: Map<string, number>;
}

// Box shadows paint outside the box; the sum of their lengths bounds how far.
function shadowReach(boxShadow: string): number {
	if (!boxShadow || boxShadow === "none") return 0;
	let sum = 0;
	for (const m of boxShadow.matchAll(/(-?[\d.]+)px/g))
		sum += Math.abs(Number(m[1]));
	return sum;
}

// Antialiased edges, a blur's spread and shadows all change pixels just outside the box.
const spill = (e: TrackedElement) =>
	4 + 3 * blurPx(e.filter) + shadowReach(e.boxShadow);

function boxOf(
	a: TrackedElement | undefined,
	b: TrackedElement | undefined,
	pad: number,
): Rect | null {
	const boxes = [a, b].filter(
		(e): e is TrackedElement => e !== undefined && e.w > 0 && e.h > 0,
	);
	if (boxes.length === 0) return null;
	return {
		x0: Math.min(...boxes.map((e) => e.x)) - pad,
		y0: Math.min(...boxes.map((e) => e.y)) - pad,
		x1: Math.max(...boxes.map((e) => e.x + e.w)) + pad,
		y1: Math.max(...boxes.map((e) => e.y + e.h)) + pad,
	};
}

function fill(
	mask: Uint8Array,
	width: number,
	height: number,
	r: Rect,
	toPx: (v: number, axis: "x" | "y") => number,
): void {
	const x0 = Math.max(0, Math.floor(toPx(r.x0, "x")));
	const y0 = Math.max(0, Math.floor(toPx(r.y0, "y")));
	const x1 = Math.min(width, Math.ceil(toPx(r.x1, "x")));
	const y1 = Math.min(height, Math.ceil(toPx(r.y1, "y")));
	for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
}

const elementsOf = (track: Track, i: number) => {
	const out = new Map<string, TrackedElement>();
	for (const [sel, list] of Object.entries(track.frames[i]?.elements ?? {}))
		for (const e of list) out.set(elementKey(sel, e.index), e);
	return out;
};

/** Frame-to-frame pixel change of the reference that no row explains, split by tracked element. */
export async function pixelActivity(input: ActivityInput): Promise<Activity> {
	const { dir, track, clip, explained, pixelDiff } = input;
	const n = track.frames.length;
	const t = track.frames.map((f) => f.t);
	const elements = new Map<string, number[]>();
	const areas = new Map<string, number>();
	const untracked = new Array<number>(n).fill(0);
	const untrackedBox: (Rect | null)[] = new Array(n).fill(null);
	let prev = n > 0 ? await readPng(dir, 0) : null;
	const scrollY = (i: number) => track.frames[i]?.scrollY ?? 0;
	for (let i = 1; i < n && prev; i++) {
		const cur = await readPng(dir, i);
		if (cur.width !== prev.width || cur.height !== prev.height) break;
		// While the page scrolls everything moves, and scroll-linked paint can lag the sampled boxes by a frame.
		const scrolling =
			scrollY(i) !== scrollY(i - 1) ||
			(i + 1 < n && scrollY(i + 1) !== scrollY(i));
		if (scrolling) {
			prev = cur;
			continue;
		}
		const { width, height } = cur;
		const scale = width / clip.width;
		const pxArea = 1 / (scale * scale);
		const toPx = (v: number, axis: "x" | "y") =>
			(v - (axis === "x" ? clip.x : clip.y)) * scale;
		const before = elementsOf(track, i - 1);
		const after = elementsOf(track, i);
		const keys = [...new Set([...before.keys(), ...after.keys()])];
		const why = explained(i);
		const mask = new Uint8Array(width * height);
		const owners: { key: string; r: Rect; hits: number }[] = [];
		for (const key of keys) {
			const a = before.get(key);
			const b = after.get(key);
			const own = boxOf(a, b, 2);
			if (!own) continue;
			const area = (own.x1 - own.x0 - 4) * (own.y1 - own.y0 - 4);
			areas.set(key, Math.max(areas.get(key) ?? 0, area));
			if (!elements.has(key)) elements.set(key, new Array(n).fill(0));
			owners.push({ key, r: own, hits: 0 });
			if (why.has(key)) {
				const pad = Math.max(
					spill(a ?? (b as TrackedElement)),
					spill(b ?? (a as TrackedElement)),
				);
				const r = boxOf(a, b, pad);
				if (r) fill(mask, width, height, r, toPx);
			}
		}
		const px = owners.map((o) => ({
			...o,
			x0: toPx(o.r.x0, "x"),
			y0: toPx(o.r.y0, "y"),
			x1: toPx(o.r.x1, "x"),
			y1: toPx(o.r.y1, "y"),
		}));
		let free = 0;
		let box: Rect | null = null;
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++) {
				const p = y * width + x;
				if (mask[p]) continue;
				const o = p * 4;
				const d = Math.max(
					Math.abs((cur.data[o] ?? 0) - (prev.data[o] ?? 0)),
					Math.abs((cur.data[o + 1] ?? 0) - (prev.data[o + 1] ?? 0)),
					Math.abs((cur.data[o + 2] ?? 0) - (prev.data[o + 2] ?? 0)),
				);
				if (d < pixelDiff) continue;
				let owned = false;
				for (const q of px)
					if (x >= q.x0 && x < q.x1 && y >= q.y0 && y < q.y1) {
						q.hits++;
						owned = true;
					}
				if (owned) continue;
				free++;
				box = box
					? {
							x0: Math.min(box.x0, x),
							y0: Math.min(box.y0, y),
							x1: Math.max(box.x1, x + 1),
							y1: Math.max(box.y1, y + 1),
						}
					: { x0: x, y0: y, x1: x + 1, y1: y + 1 };
			}
		for (const q of px) (elements.get(q.key) as number[])[i] = q.hits * pxArea;
		untracked[i] = free * pxArea;
		untrackedBox[i] = box
			? {
					x0: box.x0 / scale,
					y0: box.y0 / scale,
					x1: box.x1 / scale,
					y1: box.y1 / scale,
				}
			: null;
		prev = cur;
	}
	return { t, elements, untracked, untrackedBox, areas };
}
