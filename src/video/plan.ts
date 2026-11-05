import { type ColourModel, persistentModel, swapModel } from "./colour.ts";
import { continuous } from "./colour-continuity.ts";
import type { Plane } from "./luma.ts";
import type { Rect } from "./match.ts";
import { pickRef, spread, structureInside, tighten } from "./regions.ts";
import { changedShare, restPlateaus, type Scan, sameState } from "./scan.ts";
import {
	type Anchor,
	type End,
	expand,
	MARGIN,
	type RegionPlan,
	type TrackRegionInput,
} from "./state.ts";
import { findTravel } from "./travel.ts";

// A changed-content box this close to the whole region did not tighten: the background changed too.
const UNTIGHTENED = 0.9;
// The colour box replaces such a box when it is clearly smaller.
const SMALLER = 0.8;
// Colours are used only when their box holds this share of the reference window's luma variance.
const MIN_STRUCTURE = 0.5;
// Mean luma change of the context ring between the anchors above which the ring is left out of the template.
const RING_CHANGE = 12;

const areaOf = (r: Rect) => r.w * r.h;
const shift = (r: Rect, dx: number, dy: number): Rect => ({
	...r,
	x: r.x + dx,
	y: r.y + dy,
});

/**
 * The two frames a region is planned from: null for the clip's two ends, or, when the clip ends in the state it
 * starts in (a loop), frame 0 and the rest plateau that differs most from it.
 */
export function anchorFrames(
	scan: Scan,
	r: Rect,
	floor: number,
): [number, number] | null {
	const n = scan.frames;
	if (!sameState(scan, 0, n - 1, r, floor)) return null;
	const far = (k: number) => changedShare(scan, k, 0, r, floor);
	const away = restPlateaus(scan, r, floor).filter(
		(p) => !sameState(scan, p.k, 0, r, floor),
	);
	if (away.length === 0) return null;
	return [0, away.reduce((a, p) => (far(p.k) > far(a.k) ? p : a)).k];
}

/** Persistent colours that stay connected between the anchors, else replaced-content colours, else none. */
async function colourOf(
	dir: string,
	r: Rect,
	ref: Anchor,
	other: Anchor,
	tight: Rect,
): Promise<ColourModel | null> {
	const p = persistentModel(ref.rgba, other.rgba, tight, r);
	if (p && (await continuous(p, dir, ref.k, other.k))) return p;
	return swapModel(ref.rgba, other.rgba, tight, r);
}

/**
 * Plan from one clip end (ADR 0002): the changed content, tightened to the element's colours when they hold most
 * of its structure; the colour box becomes the element box for a persistent element, or when the whole region
 * changed (a dimming backdrop, for instance).
 */
async function endPlan(
	dir: string,
	r: TrackRegionInput,
	ref: Anchor,
	other: Anchor,
	label: End,
	floor: number,
): Promise<RegionPlan> {
	const tight = tighten(ref.plane, other.plane, r, floor);
	const found = await colourOf(dir, r, ref, other, tight);
	const colour =
		found && structureInside(ref.plane, tight, found.box) >= MIN_STRUCTURE
			? found
			: null;
	const replace =
		colour &&
		(colour.otherBox !== null ||
			(areaOf(tight) >= UNTIGHTENED * areaOf(r) &&
				areaOf(colour.box) < SMALLER * areaOf(tight)));
	return {
		ref,
		other,
		label,
		box: replace ? colour.box : tight,
		ring: MARGIN,
		colour,
		floor,
		bounded: false,
	};
}

/**
 * The automatic end: for an element whose colours persist and stay connected between the ends, the end where it
 * is larger, so it has the most pixels and a grow reads towards 1; otherwise the end with more structure.
 */
async function autoEnd(
	dir: string,
	r: Rect,
	first: Anchor,
	last: Anchor,
	floor: number,
): Promise<End> {
	const tight = tighten(first.plane, last.plane, r, floor);
	const c = persistentModel(first.rgba, last.rgba, tight, r);
	if (c?.otherBox && (await continuous(c, dir, first.k, last.k)))
		return areaOf(c.otherBox) > areaOf(c.box) ? "last" : "first";
	return pickRef(first.plane, last.plane, expand(tight, MARGIN, first.plane));
}

/** Mean absolute luma change of the ring around a box between two frames, where the box sits at each. */
function ringChange(a: Plane, ba: Rect, b: Plane, bb: Rect): number {
	const wa = expand(ba, MARGIN, a);
	let sum = 0;
	let n = 0;
	for (let y = wa.y; y < wa.y + wa.h; y++)
		for (let x = wa.x; x < wa.x + wa.w; x++) {
			if (x >= ba.x && y >= ba.y && x < ba.x + ba.w && y < ba.y + ba.h)
				continue;
			const xb = x - ba.x + bb.x;
			const yb = y - ba.y + bb.y;
			if (xb < 0 || yb < 0 || xb >= b.width || yb >= b.height) continue;
			sum += Math.abs(
				(a.data[y * a.width + x] as number) -
					(b.data[yb * b.width + xb] as number),
			);
			n++;
		}
	return n ? sum / n : 0;
}

/**
 * Plan from rest plateaus: the element is the content that travels between the two anchors and stays in the
 * region at both (or the changed content when nothing travels), the reference is the anchor where it shows more
 * structure with its surroundings, and the context ring is dropped when the surroundings change between them,
 * as when the whole page flips from light to dark.
 */
export function restPlan(
	r: TrackRegionInput,
	a: Anchor,
	b: Anchor,
	frames: number,
	floor: number,
	t = findTravel(a.frame, b.frame, r, floor),
): [RegionPlan, RegionPlan] {
	const boxA = t?.box ?? tighten(a.plane, b.plane, r, floor);
	const boxB = shift(boxA, t?.dx ?? 0, t?.dy ?? 0);
	const ring =
		ringChange(a.plane, boxA, b.plane, boxB) > RING_CHANGE ? 0 : MARGIN;
	const label = (k: number): RegionPlan["label"] =>
		k === 0 ? "first" : k === frames - 1 ? "last" : "rest";
	const plan = (ref: Anchor, other: Anchor, box: Rect): RegionPlan => ({
		ref,
		other,
		label: label(ref.k),
		box,
		ring,
		colour: null,
		floor,
		bounded: true,
	});
	const pa = plan(a, b, boxA);
	const pb = plan(b, a, boxB);
	// When the element leaves the region, the reference is the anchor where the region holds it.
	const aFirst =
		r.ref === "first" ||
		(r.ref === "auto" &&
			(t?.leaves === true ||
				spread(a.plane, expand(boxA, MARGIN, a.plane)) >=
					spread(b.plane, expand(boxB, MARGIN, b.plane))));
	return aFirst ? [pa, pb] : [pb, pa];
}

export interface Plans {
	main: RegionPlan;
	/** Null when the other anchor holds something else in the element's place. */
	other: RegionPlan | null;
}

/**
 * Plan content that stays in place (ADR 0002, automatic regions): the reference is the frame where it shows, the
 * other anchor the rest state that differs most from it, and there is no track from that anchor, because there
 * the region holds whatever covers the content.
 */
async function stillPlan(
	r: TrackRegionInput,
	at: number,
	scan: Scan,
	anchorAt: (k: number) => Promise<Anchor>,
	floor: number,
): Promise<Plans> {
	const n = scan.frames;
	const far = (k: number) => changedShare(scan, k, at, r, floor);
	const ks = [0, n - 1, ...restPlateaus(scan, r, floor).map((p) => p.k)];
	const [ref, other] = await Promise.all(
		[at, ks.reduce((a, k) => (far(k) > far(a) ? k : a))].map(anchorAt),
	);
	const a = ref as Anchor;
	const b = other as Anchor;
	const box = tighten(a.plane, b.plane, r, floor);
	const label = at === 0 ? "first" : at === n - 1 ? "last" : "rest";
	const ring =
		ringChange(a.plane, box, b.plane, box) > RING_CHANGE ? 0 : MARGIN;
	return {
		main: {
			ref: a,
			other: b,
			label,
			box,
			ring,
			colour: null,
			floor,
			bounded: false,
		},
		other: null,
	};
}

/** The main plan of a region and the plan from its other anchor. */
export async function planRegion(
	dir: string,
	r: TrackRegionInput,
	scan: Scan,
	anchorAt: (k: number) => Promise<Anchor>,
	floor: number,
): Promise<Plans> {
	if (r.at !== undefined) return stillPlan(r, r.at, scan, anchorAt, floor);
	const n = scan.frames;
	const rest = anchorFrames(scan, r, floor);
	if (rest) {
		const [a, b] = (await Promise.all(rest.map(anchorAt))) as [Anchor, Anchor];
		const [main, other] = restPlan(r, a, b, n, floor);
		return { main, other };
	}
	const first = await anchorAt(0);
	const last = await anchorAt(n - 1);
	const end =
		r.ref === "auto" ? await autoEnd(dir, r, first, last, floor) : r.ref;
	const [ref, other] = end === "first" ? [first, last] : [last, first];
	const main = await endPlan(dir, r, ref, other, end, floor);
	// Nothing narrowed the element down, as when the whole page changes colour: look for content that travels
	// and stays in the region.
	const travel =
		main.colour === null && areaOf(main.box) >= UNTIGHTENED * areaOf(r)
			? findTravel(first.frame, last.frame, r, floor)
			: null;
	if (!travel || travel.leaves)
		return {
			main,
			other: await endPlan(
				dir,
				r,
				other,
				ref,
				end === "first" ? "last" : "first",
				floor,
			),
		};
	const [m, o] = restPlan(r, first, last, n, floor, travel);
	return { main: m, other: o };
}
