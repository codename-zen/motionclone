import {
	best,
	type Frame,
	type Grid,
	type Hit,
	subPixel,
	vertex,
} from "./match.ts";
import { FACTOR, type LevelName, type TemplateModel } from "./model.ts";

/** Where and how the element appears: centre in frame pixels, scale against the reference, blur in reference pixels. */
export interface Pose {
	cx: number;
	cy: number;
	s: number;
	blur: number;
}

export interface Fit extends Pose {
	ncc: number;
	contrast: number;
	/** Luma standard deviation of the frame under the fitted model. */
	spread: number;
}

/** Parameters held at the prediction instead of searched. */
export interface Lock {
	scale: boolean;
	blur: boolean;
}

const MIN_SCALE = 0.3;
const MAX_SCALE = 3;
const COARSE_RADIUS = 10;
const PLACE_RADIUS = 2;
const FLAT_RADIUS = 16;
const MIN_COARSE_SIDE = 8;
// Templates larger than this (full-resolution pixels) refine scale and blur at half resolution.
const HALF_ABOVE = 40_000;
const COARSE_STEP = 1.06;
const FINE_STEP = 1.02;
const SCALE_STEPS = 2;
// Reference-frame pixels; roughly 1.4x apart so neighbouring candidates still overlap.
const BLURS = [0, 1, 2, 3, 4.5, 6.5, 9, 13, 18, 25, 35];
const BLUR_STEPS = 2;
export const MAX_BLUR = BLURS.at(-1) as number;

export const clampScale = (s: number) =>
	Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

interface Try extends Fit {
	grid: Grid;
	hit: Hit;
	level: LevelName;
	/** Sub-pixel offset the template was rendered at, level pixels. */
	ox: number;
	oy: number;
}

// The template is rendered at the pose's sub-pixel offset, so scale and blur never absorb a misalignment.
function attempt(
	f: Frame,
	model: TemplateModel,
	level: LevelName,
	pose: Pose,
	r: number,
): Try {
	const k = FACTOR[level];
	const { w, h } = model.size(level, pose.s);
	const rx = pose.cx / k - w / 2;
	const ry = pose.cy / k - h / 2;
	const x = Math.round(rx);
	const y = Math.round(ry);
	const ox = rx - x;
	const oy = ry - y;
	const grid = model.render(level, pose.s, pose.blur, ox, oy);
	const hit = best(f[level], grid, x, y, r);
	return {
		...pose,
		cx: (hit.x + ox + w / 2) * k,
		cy: (hit.y + oy + h / 2) * k,
		ncc: hit.ncc,
		contrast: hit.contrast,
		spread: hit.spread,
		grid,
		hit,
		level,
		ox,
		oy,
	};
}

/** Move a try to its sub-pixel peak on its level and score it there. */
function settle(f: Frame, model: TemplateModel, t: Try): Try {
	const k = FACTOR[t.level];
	const at = subPixel(f[t.level], t.grid, t.hit);
	const pose = {
		...t,
		cx: (at.x + t.ox + t.grid.w / 2) * k,
		cy: (at.y + t.oy + t.grid.h / 2) * k,
	};
	return better(t, attempt(f, model, t.level, pose, 0));
}

const fitOf = (t: Try): Fit => ({
	cx: t.cx,
	cy: t.cy,
	s: t.s,
	blur: t.blur,
	ncc: t.ncc,
	contrast: t.contrast,
	spread: t.spread,
});

const better = (a: Try, b: Try) => (b.ncc > a.ncc ? b : a);

function nearestBlur(b: number): number {
	let i = 0;
	for (let j = 1; j < BLURS.length; j++)
		if (Math.abs((BLURS[j] as number) - b) < Math.abs((BLURS[i] as number) - b))
			i = j;
	return i;
}

/** Scale, then blur candidates on a level around the current pose, twice, each with a small shift search. */
function grid(
	f: Frame,
	model: TemplateModel,
	level: LevelName,
	cur: Try,
	lock: Lock,
): Try {
	let top = cur;
	for (let round = 0; round < 2; round++) {
		const from = top;
		for (let i = -SCALE_STEPS; i <= SCALE_STEPS; i++) {
			if (lock.scale) break;
			const s = clampScale(from.s * COARSE_STEP ** i);
			if (s !== from.s)
				top = better(top, attempt(f, model, level, { ...from, s }, 1));
		}
		const mid = top;
		if (lock.blur) continue;
		const b0 = nearestBlur(mid.blur);
		for (const blur of BLURS.slice(
			Math.max(0, b0 - BLUR_STEPS),
			b0 + BLUR_STEPS + 1,
		))
			if (blur !== mid.blur)
				top = better(top, attempt(f, model, level, { ...mid, blur }, 1));
	}
	return top;
}

/** Refine one parameter on the try's level: step both ways, then a parabola through the three best samples. */
function refine(
	f: Frame,
	model: TemplateModel,
	cur: Try,
	key: "s" | "blur",
	step: (v: number, dir: -1 | 1) => number,
): Try {
	let mid = cur;
	for (let n = 0; n < 6; n++) {
		const lo = attempt(
			f,
			model,
			mid.level,
			{ ...mid, [key]: step(mid[key], -1) },
			1,
		);
		const hi = attempt(
			f,
			model,
			mid.level,
			{ ...mid, [key]: step(mid[key], 1) },
			1,
		);
		if (lo[key] !== mid[key] && lo.ncc > mid.ncc && lo.ncc >= hi.ncc) mid = lo;
		else if (hi[key] !== mid[key] && hi.ncc > mid.ncc) mid = hi;
		else {
			if (lo[key] === mid[key] || hi[key] === mid[key]) return mid;
			const t = vertex(lo.ncc, mid.ncc, hi.ncc);
			const v =
				t < 0
					? mid[key] + t * (mid[key] - lo[key])
					: mid[key] + t * (hi[key] - mid[key]);
			return better(mid, attempt(f, model, mid.level, { ...mid, [key]: v }, 1));
		}
	}
	return mid;
}

/**
 * Find the element near a predicted pose: shift, then scale and blur on the coarse level,
 * then shift, scale and blur at full resolution, and finally a sub-pixel shift.
 * Scale and blur stay near the prediction: a free search lets a small, heavily blurred template lock onto nearby text.
 */
export function search(
	f: Frame,
	model: TemplateModel,
	pred: Pose,
	lock: Lock,
): Fit {
	const { w, h } = model.size("full", pred.s);
	const level: LevelName =
		Math.min(w, h) / FACTOR.coarse >= MIN_COARSE_SIDE ? "coarse" : "full";
	const fine: LevelName = w * h > HALF_ABOVE ? "half" : "full";
	let cur = attempt(
		f,
		model,
		level,
		pred,
		level === "coarse" ? COARSE_RADIUS : FLAT_RADIUS,
	);
	cur = grid(f, model, level, cur, lock);
	if (level !== fine)
		cur = attempt(f, model, fine, cur, FACTOR[level] / FACTOR[fine] / 2 + 1);
	cur = settle(f, model, cur);
	if (!lock.scale)
		cur = refine(f, model, cur, "s", (s, d) => clampScale(s * FINE_STEP ** d));
	if (!lock.blur)
		cur = refine(f, model, cur, "blur", (b, d) =>
			Math.min(MAX_BLUR, Math.max(0, b + d * Math.max(0.5, 0.15 * b))),
		);
	return fitOf(settle(f, model, attempt(f, model, "full", cur, 1)));
}

/** Shift only, at a fixed scale and blur, near a pose. */
export function place(f: Frame, model: TemplateModel, pose: Pose): Fit {
	return fitOf(settle(f, model, attempt(f, model, "full", pose, PLACE_RADIUS)));
}
