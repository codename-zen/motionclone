import { stillContent, type Transition } from "./content.ts";
import { type Plane, readLuma } from "./luma.ts";
import { COARSE, pyramid, type Rect } from "./match.ts";
import { components, type NamedRect } from "./regions.ts";
import { restPlateaus, type Scan, sameState } from "./scan.ts";
import { findTravel } from "./travel.ts";

const CELL = COARSE;
// A blob whose box covers this share of the frame is a whole-screen change, such as a light to dark flip.
const WHOLE = 0.5;
// Travelling content is given this much room around its sweep, so the tracked box fits inside with a margin.
const SWEEP_PAD = 16;
// Two sweeps overlapping by this share of the smaller one are one element.
const SAME_SWEEP = 0.5;

/** Peak mean change of every 4 px cell against frame 0, fed one frame at a time. */
export function changePeaks(width: number, height: number) {
	const cw = Math.floor(width / CELL);
	const ch = Math.floor(height / CELL);
	const peak = new Float32Array(cw * ch);
	const sums = new Float32Array(cw * ch);
	let first: Plane | null = null;
	const visit = (_k: number, p: Plane) => {
		if (!first) {
			first = p;
			return;
		}
		const f = first;
		sums.fill(0);
		for (let y = 0; y < ch * CELL; y++)
			for (let x = 0; x < cw * CELL; x++) {
				const o = y * width + x;
				const c = Math.floor(y / CELL) * cw + Math.floor(x / CELL);
				sums[c] =
					(sums[c] as number) +
					Math.abs((p.data[o] as number) - (f.data[o] as number));
			}
		for (let c = 0; c < peak.length; c++)
			peak[c] = Math.max(
				peak[c] as number,
				(sums[c] as number) / (CELL * CELL),
			);
	};
	return { visit, peak, cw, ch };
}

/** Add the change of every cell against the rest plateau before it, so each transition counts on its own. */
function addTransitions(
	s: Scan,
	peak: Float32Array,
	cw: number,
	reps: number[],
): void {
	let base = 0;
	for (let k = 1; k < s.frames; k++) {
		const b = s.coarse[base] as Uint8Array;
		const c = s.coarse[k] as Uint8Array;
		for (let i = 0; i < peak.length; i++) {
			const o = Math.floor(i / cw) * s.width + (i % cw);
			peak[i] = Math.max(
				peak[i] as number,
				Math.abs((c[o] as number) - (b[o] as number)),
			);
		}
		if (reps.includes(k)) base = k;
	}
}

const overlap = (a: Rect, b: Rect) => {
	const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? (w * h) / Math.min(a.w * a.h, b.w * b.h) : 0;
};

const union = (a: Rect, b: Rect): Rect => {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		w: Math.max(a.x + a.w, b.x + b.w) - x,
		h: Math.max(a.y + a.h, b.y + b.h) - y,
	};
};

/**
 * Inside a whole-screen change, the content that travels between consecutive rest states: for each transition,
 * the box that moves and where it goes, padded; overlapping sweeps merge. Empty when nothing travels.
 * Also returns the transitions, for the content that stays in place.
 */
async function travelling(
	dir: string,
	blob: Rect,
	reps: number[],
	frame: Rect,
	floor: number,
): Promise<{ sweeps: Rect[]; transitions: Transition[] }> {
	const sweeps: Rect[] = [];
	const transitions: Transition[] = [];
	for (let i = 0; i + 1 < reps.length; i++) {
		const [ka, kb] = [reps[i] as number, reps[i + 1] as number];
		const [pa, pb] = await Promise.all([ka, kb].map((k) => readLuma(dir, k)));
		const t = findTravel(
			pyramid(pa as Plane),
			pyramid(pb as Plane),
			blob,
			floor,
		);
		transitions.push({
			a: { k: ka, plane: pa as Plane },
			b: { k: kb, plane: pb as Plane },
			travel: t,
		});
		if (!t) continue;
		let r = union(t.box, { ...t.box, x: t.box.x + t.dx, y: t.box.y + t.dy });
		const x = Math.max(frame.x, r.x - SWEEP_PAD);
		const y = Math.max(frame.y, r.y - SWEEP_PAD);
		r = {
			x,
			y,
			w: Math.min(frame.w, r.x + r.w + SWEEP_PAD) - x,
			h: Math.min(frame.h, r.y + r.h + SWEEP_PAD) - y,
		};
		const same = sweeps.findIndex((q) => overlap(q, r) >= SAME_SWEEP);
		if (same >= 0) sweeps[same] = union(sweeps[same] as Rect, r);
		else sweeps.push(r);
	}
	return { sweeps, transitions };
}

/**
 * One region per connected blob of cells that changed by more than the noise floor in some transition: against
 * frame 0 and against the rest plateau before it. A blob covering most of the frame is replaced by the content
 * that travels inside it when there is any, so a page flipping from light to dark does not hide a moving sheet,
 * plus the content that changes in place around it, such as what the sheet reveals.
 */
export async function findBlobs(
	dir: string,
	scan: Scan,
	changes: ReturnType<typeof changePeaks>,
	floor: number,
	max: number,
	warnings: string[],
): Promise<(NamedRect & { at?: number })[]> {
	const { peak, cw, ch } = changes;
	const frame = { x: 0, y: 0, w: scan.first.width, h: scan.first.height };
	const reps = restPlateaus(scan, frame, floor)
		.map((p) => p.k)
		.filter(
			(k, i, all) =>
				i === 0 || !sameState(scan, all[i - 1] as number, k, frame, floor),
		);
	addTransitions(scan, peak, cw, reps);
	const mask = Uint8Array.from(peak, (v) => (v > floor ? 1 : 0));
	const rects: (Rect & { at?: number })[] = [];
	for (const b of components(mask, cw, ch)) {
		const r = { x: b.x * CELL, y: b.y * CELL, w: b.w * CELL, h: b.h * CELL };
		if (r.w * r.h < WHOLE * frame.w * frame.h) {
			rects.push(r);
			continue;
		}
		const { sweeps, transitions } = await travelling(
			dir,
			r,
			reps,
			frame,
			floor,
		);
		if (sweeps.length === 0) rects.push(r);
		else rects.push(...sweeps, ...stillContent(transitions, r, frame));
	}
	let kept = rects;
	if (kept.length > max) {
		warnings.push(
			`found ${kept.length} moving blobs; kept the ${max} largest (raise maxRegions or declare regions)`,
		);
		kept = kept.slice(0, max);
	}
	const band = CELL * 4;
	return kept
		.sort(
			(a, b) => Math.round(a.y / band) - Math.round(b.y / band) || a.x - b.x,
		)
		.map((r, i) => ({ name: `blob[${i}]`, ...r }));
}
