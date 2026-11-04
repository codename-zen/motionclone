import { acquire, changed } from "./acquire.ts";
import { type ColourReading, poseOf, readColour } from "./colour.ts";
import type { Rgba } from "./luma.ts";
import type { Frame } from "./match.ts";
import { type Judgement, judge, MIN_SHAPE_CONTRAST } from "./quality.ts";
import type { Method, RegionSample } from "./samples.ts";
import {
	clampScale,
	type Fit,
	MAX_BLUR,
	type Pose,
	place,
	search,
} from "./search.ts";
import { isFound, type State, shiftOf, still } from "./state.ts";
import { matchStructure } from "./structure.ts";

// The template and colour readings agree within these: scale in log units, centre in pixels or a share of the box.
const SCALE_AGREE = 0.03;
const PLACE_AGREE_PX = 3;
const PLACE_AGREE_SHARE = 0.015;
// Quality of a frame whose two readings disagree is scaled by this.
const DISAGREE = 0.5;
// A found reading stays connected to the last one: scale within this (log units) of the prediction per frame
// since then, counting at most MAX_GAP frames, so a different element that looks alike is not taken over.
const MAX_SCALE_STEP = 0.2;
const MAX_GAP = 2;

const predict = (s: State): Pose => ({
	cx: s.pose.cx + s.vel.cx,
	cy: s.pose.cy + s.vel.cy,
	s: clampScale(s.pose.s * Math.exp(s.vel.s)),
	blur: Math.min(MAX_BLUR, Math.max(0, s.pose.blur + s.vel.blur)),
});

/** The pose a colour box gives: its centre moved by the box offset, at its scale and the last blur. */
function colourPose(s: State, r: ColourReading): Pose {
	const c = poseOf(s.colour as NonNullable<State["colour"]>, r);
	const sc = s.lock.scale ? s.pose.s : c.s;
	return {
		cx: c.x + sc * (s.colourOffset.x - s.offset.x),
		cy: c.y + sc * (s.colourOffset.y - s.offset.y),
		s: sc,
		blur: s.pose.blur,
	};
}

function agree(s: State, m: Fit, shaped: boolean, c: Pose): boolean {
	const a = shiftOf(s, m);
	const b = shiftOf(s, c);
	const size = Math.max(s.region.box.w, s.region.box.h) * c.s;
	const near =
		Math.hypot(a.dx - b.dx, a.dy - b.dy) <=
		Math.max(PLACE_AGREE_PX, PLACE_AGREE_SHARE * size);
	return near && (!shaped || Math.abs(Math.log(m.s / c.s)) <= SCALE_AGREE);
}

/**
 * The template reading: near the colour box or else the prediction, then at the expected place,
 * then, without a colour box, a wide search when the region changed since the last one failed.
 */
function templateFit(
	s: State,
	f: Frame,
	cp: Pose | null,
	k: number,
): { m: Fit; j: Judgement } {
	const pred = predict(s);
	const connected = (m: Fit, j: Judgement) =>
		j.status !== "found" ||
		s.lastK < 0 ||
		Math.abs(Math.log(m.s / pred.s)) <=
			MAX_SCALE_STEP * Math.min(MAX_GAP, Math.abs(k - s.lastK));
	const judged = (m: Fit): Judgement => {
		const j = judge(m, s.noise);
		return connected(m, j) ? j : { ...j, status: "other" };
	};
	let m = search(f, s.model, cp ?? pred, s.lock);
	if (m.contrast < MIN_SHAPE_CONTRAST)
		m = place(f, s.model, { ...m, s: s.pose.s, blur: s.pose.blur });
	let j = judged(m);
	if (isFound(j.status)) return { m, j };
	// The search may have strayed onto nearby content: judge what is at the expected place instead.
	m = place(f, s.model, { ...pred, s: s.pose.s, blur: s.pose.blur });
	j = judged(m);
	if (isFound(j.status) || cp) return { m, j };
	if (j.status !== "other" && !s.prevFound) return { m, j };
	if (s.missed && !changed(s.missed, f.coarse, s.area)) return { m, j };
	const a = acquire(
		f,
		s.model,
		s.area,
		{ ...pred, s: s.pose.s, blur: s.pose.blur },
		s.lock,
		s.noise,
	);
	const ok = a !== null && connected(a.fit, a.judgement);
	s.missed = ok ? null : f.coarse;
	return ok ? { m: a.fit, j: a.judgement } : { m, j };
}

export function step(s: State, f: Frame, rgba: Rgba, k: number) {
	const reading = s.colour ? readColour(s.colour, rgba) : null;
	const cp = reading ? colourPose(s, reading) : null;
	let { m, j } = templateFit(s, f, cp, k);
	let { status, quality } = j;
	let method: Method = "none";
	let opacity = isFound(status) ? Math.min(1, Math.max(0, m.contrast)) : 0;
	if (isFound(status) && cp) {
		const ok = agree(s, m, status === "found", cp);
		method = ok ? "both-agree" : "disagree";
		if (!ok) quality *= DISAGREE;
	} else if (isFound(status)) method = "template";
	else if (cp && reading) {
		method = "colour";
		status = "found";
		quality = Math.min(1, reading.fill / (s.colour?.fill ?? 1));
		opacity = 1;
		m = { ...cp, ncc: 0, contrast: 1, spread: 0 };
	} else if (s.structure) {
		const p = shiftOf(s, predict(s));
		const r = matchStructure(s.structure, f, s.area, { x: p.dx, y: p.dy });
		if (r) {
			method = "structure";
			status = "found";
			quality = r.quality;
			opacity = 1;
			const { s: sc, blur } = s.pose;
			m = {
				cx: s.home.x + r.dx - sc * s.offset.x,
				cy: s.home.y + r.dy - sc * s.offset.y,
				s: sc,
				blur,
				ncc: 0,
				contrast: 1,
				spread: 0,
			};
		}
	}
	const found = isFound(status);
	Object.assign(s.region.samples[k] as RegionSample, {
		found,
		...shiftOf(s, m),
		scale: m.s,
		blur: m.blur,
		ncc: m.ncc,
		opacity,
		quality: Math.round(quality * 1000) / 1000,
		status,
		method,
	});
	if (found) {
		const shaped = status === "found";
		const next: Pose = {
			cx: m.cx,
			cy: m.cy,
			s: shaped ? m.s : s.pose.s,
			blur: shaped ? m.blur : s.pose.blur,
		};
		s.vel = s.prevFound
			? {
					cx: next.cx - s.pose.cx,
					cy: next.cy - s.pose.cy,
					s: Math.log(next.s / s.pose.s),
					blur: next.blur - s.pose.blur,
				}
			: still;
		s.pose = next;
		s.lastK = k;
	} else s.vel = still;
	s.prevFound = found;
}
