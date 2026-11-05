import type { Plane } from "./luma.ts";
import { COARSE, type Frame, type Rect, score } from "./match.ts";
import { FACTOR, type LevelName, type TemplateModel } from "./model.ts";
import { type Judgement, judge } from "./quality.ts";
import {
	type Fit,
	type Lock,
	MAX_SCALE,
	MIN_SCALE,
	type Pose,
	search,
} from "./search.ts";

// Log steps of 10 %: the refining search walks 12 % each way, so neighbouring candidates overlap.
const STEP = 1.1;
const LEVELS: LevelName[] = ["tiny", "coarse", "half", "full"];
// Templates get the smallest level that keeps this many pixels on their short side.
const MIN_SIDE = 8;
// Best placements, from distinct scales or places, refined with the full search.
const CANDIDATES = 3;
// Mean luma change in the area, at quarter resolution, after which a failed wide search is worth repeating.
const CHANGED = 1;

interface Candidate {
	cx: number;
	cy: number;
	s: number;
	ncc: number;
}

/** Best placement of the model at one scale anywhere inside the area. */
function slide(
	f: Frame,
	model: TemplateModel,
	area: Rect,
	s: number,
	blur: number,
): Candidate | null {
	const level =
		LEVELS.find((l) => {
			const { w, h } = model.size(l, s);
			return Math.min(w, h) >= MIN_SIDE;
		}) ?? "full";
	const k = FACTOR[level];
	const g = model.render(level, s, blur);
	const p = f[level];
	// Placements inside the area; on an axis where the template does not fit, those whose centre lies in it, so a
	// region barely larger than the element still has some.
	const span = (from: number, len: number, size: number, max: number) => {
		const lo = Math.max(0, Math.ceil(from / k));
		const hi = Math.min(max, Math.floor((from + len) / k)) - size;
		if (hi >= lo) return [lo, hi];
		return [
			Math.max(0, Math.ceil(from / k - size / 2)),
			Math.min(max - size, Math.floor((from + len) / k - size / 2)),
		];
	};
	const [x0, x1] = span(area.x, area.w, g.w, p.width) as [number, number];
	const [y0, y1] = span(area.y, area.h, g.h, p.height) as [number, number];
	let top: Candidate | null = null;
	for (let y = y0; y <= y1; y++)
		for (let x = x0; x <= x1; x++) {
			const r = score(p, g, x, y);
			if (r && (!top || r.ncc > top.ncc))
				top = { cx: (x + g.w / 2) * k, cy: (y + g.h / 2) * k, s, ncc: r.ncc };
		}
	return top;
}

const distinct = (a: Candidate, b: Candidate, model: TemplateModel) =>
	Math.abs(Math.log(a.s / b.s)) > Math.log(STEP) * 1.5 ||
	Math.hypot(a.cx - b.cx, a.cy - b.cy) >
		(Math.min(model.win.w, model.win.h) * a.s) / 4;

/**
 * Search the whole area over the full scale range at reduced resolution, refine the best placements
 * with the regular search, and keep the best one the quality gate accepts as found.
 */
export function acquire(
	f: Frame,
	model: TemplateModel,
	area: Rect,
	pose: Pose,
	lock: Lock,
	noise: number,
): { fit: Fit; judgement: Judgement } | null {
	const maxS = Math.min(MAX_SCALE, area.w / model.win.w, area.h / model.win.h);
	// The last clear scale is always tried, because the ladder may step past it.
	const scales: number[] = [pose.s];
	if (!lock.scale)
		for (let s = MIN_SCALE; s <= maxS * 1.0001; s *= STEP) scales.push(s);
	const all = scales
		.map((s) => slide(f, model, area, s, pose.blur))
		.filter((c): c is Candidate => c !== null)
		.sort((a, b) => b.ncc - a.ncc);
	const picked: Candidate[] = [];
	for (const c of all)
		if (
			picked.length < CANDIDATES &&
			picked.every((p) => distinct(c, p, model))
		)
			picked.push(c);
	let best: { fit: Fit; judgement: Judgement } | null = null;
	for (const c of picked) {
		const fit = search(f, model, { ...pose, cx: c.cx, cy: c.cy, s: c.s }, lock);
		const judgement = judge(fit, noise);
		if (
			judgement.status === "found" &&
			(!best || judgement.quality > best.judgement.quality)
		)
			best = { fit, judgement };
	}
	return best;
}

/** Whether the area changed since a frame where the wide search failed; compared at quarter resolution. */
export function changed(before: Plane, now: Plane, area: Rect): boolean {
	const x0 = Math.floor(area.x / COARSE);
	const y0 = Math.floor(area.y / COARSE);
	const x1 = Math.min(now.width, Math.ceil((area.x + area.w) / COARSE));
	const y1 = Math.min(now.height, Math.ceil((area.y + area.h) / COARSE));
	let sum = 0;
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const o = y * now.width + x;
			sum += Math.abs((now.data[o] as number) - (before.data[o] as number));
		}
	return sum / Math.max(1, (x1 - x0) * (y1 - y0)) >= CHANGED;
}
