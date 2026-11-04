import { markClipped } from "./clip.ts";
import { fillSamples } from "./fill.ts";
import { readFrame, readLuma } from "./luma.ts";
import { pyramid } from "./match.ts";
import { mergeEnds, rebase } from "./merge.ts";
import { type Done, frameSource, runPass } from "./pass.ts";
import { type Plans, planRegion } from "./plan.ts";
import type { RegionSample, RegionTrack } from "./samples.ts";
import type { Scan } from "./scan.ts";
import type { Lock } from "./search.ts";
import {
	type Anchor,
	initState,
	type RegionPlan,
	type State,
	type TrackRegionInput,
} from "./state.ts";

export type { TrackRegionInput } from "./state.ts";

// Within these the element does not scale or blur (h264 noise), and the region is tracked again with them fixed.
const SCALE_NOISE = 0.01;
/** Blurs under one reference-frame pixel are noise. */
export const MIN_BLUR = 1;
// Consecutive frames read at an anchor to estimate compression noise.
const NOISE_FRAMES = 4;
// The other anchor is tracked only when its window shows this many noise deviations of structure.
const MIN_STRUCTURE = 3;

// The other anchor's track stops once both tracks found this many consecutive frames, or the main track this many.
const LINK_FRAMES = 3;
const MAIN_FRAMES = 8;

/** Whether the main track already covers the frames the other track just went through, up to k. */
function covered(o: State, main: State, k: number, dir: 1 | -1): boolean {
	const ref = o.region.refFrame;
	const run = (n: number, both: boolean) =>
		Array.from({ length: n }, (_, i) => k - i * dir).every(
			(j) =>
				(j - ref) * dir >= 0 &&
				main.region.samples[j]?.found === true &&
				(!both || o.region.samples[j]?.found === true),
		);
	return run(LINK_FRAMES, true) || run(MAIN_FRAMES, false);
}

const shapedOf = (smp: RegionSample[]) => smp.map((p) => p.status === "found");
const foundCount = (s: State) => s.region.samples.filter((p) => p.found).length;

/** Fix scale or blur when they never leave their noise band, so that noise cannot leak into the position. */
function lockOf(smp: RegionSample[]): Lock {
	const clear = smp.filter((_, k) => shapedOf(smp)[k]);
	return {
		scale: clear.every((p) => Math.abs(Math.log(p.scale)) < SCALE_NOISE),
		blur: clear.every((p) => p.blur < MIN_BLUR),
	};
}

function hasStructure(s: State): boolean {
	const g = s.model.render("full", 1, 0);
	return Math.sqrt(g.sumSq / (g.w * g.h)) >= MIN_STRUCTURE * s.noise;
}

/** Reads anchors once: the frame, its pyramid and colours, and a few frames at rest from it for the noise. */
function anchorReader(dir: string, frames: number) {
	const cache = new Map<number, Promise<Anchor>>();
	const done = new Map<number, Anchor>();
	const read = async (k: number): Promise<Anchor> => {
		const n = Math.min(NOISE_FRAMES, frames);
		const from = Math.min(k, frames - n);
		const { luma, rgba } = await readFrame(dir, k);
		const near = await Promise.all(
			Array.from({ length: n }, (_, i) =>
				from + i === k ? luma : readLuma(dir, from + i),
			),
		);
		const a = { k, plane: luma, frame: pyramid(luma), rgba, near };
		done.set(k, a);
		return a;
	};
	const at = (k: number) => {
		const hit = cache.get(k) ?? read(k);
		cache.set(k, hit);
		return hit;
	};
	return { at, done };
}

/**
 * Track each region from its reference frame, and from its other anchor when frames were lost, then merge the
 * two. When the reference is automatic, the anchor whose track found more frames leads.
 * Regions where scale or blur stays within noise are tracked again with it fixed.
 */
export async function trackRegions(
	dir: string,
	scan: Scan,
	regions: TrackRegionInput[],
	floor: number,
	warnings: string[],
): Promise<RegionTrack[]> {
	const frames = scan.frames;
	const frame = { x: 0, y: 0, w: scan.first.width, h: scan.first.height };
	const anchors = anchorReader(dir, frames);
	const plans: Plans[] = [];
	for (const r of regions)
		plans.push(await planRegion(dir, r, scan, anchors.at, floor));
	const source = frameSource((k) => readFrame(dir, k), anchors.done);
	const pass = (states: State[], done?: Done) =>
		runPass(frames, states, source, scan.first, floor, done);
	// A region planned from travel holds the same element at the same size at both anchors: a rigid move.
	const free = (p: RegionPlan): Lock => ({
		scale: p.bounded,
		blur: p.bounded,
	});
	const init = (i: number, plan: RegionPlan, lock: Lock) =>
		initState(regions[i] as TrackRegionInput, plan, frames, lock);
	const used = plans.map((p) => p.main);
	const main = used.map((p, i) => init(i, p, free(p)));
	await pass(main);
	const others = new Map<number, State>();
	main.forEach((s, i) => {
		if (foundCount(s) === frames) return;
		const plan = (plans[i] as Plans).other;
		if (!plan) return;
		const o = init(i, plan, free(plan));
		if (hasStructure(o)) others.set(i, o);
	});
	const mainOf = new Map([...others].map(([i, o]) => [o, main[i] as State]));
	await pass([...others.values()], (o, k, d) =>
		covered(o, mainOf.get(o) as State, k, d),
	);
	// Values stay relative to the anchor chosen for its structure, even when the other anchor's template led.
	const measuredAt = new Map<number, RegionTrack>();
	for (const [i, o] of others)
		if (
			regions[i]?.ref === "auto" &&
			foundCount(o) > foundCount(main[i] as State)
		) {
			const m = main[i] as State;
			measuredAt.set(i, { ...m.region });
			others.set(i, m);
			main[i] = o;
			used[i] = (plans[i] as Plans).other as RegionPlan;
		}
	const again = new Map<number, State>();
	main.forEach((s, i) => {
		const lock = lockOf(s.region.samples);
		if (s.lock.scale || s.lock.blur || !(lock.scale || lock.blur)) return;
		again.set(i, init(i, used[i] as RegionPlan, lock));
	});
	await pass([...again.values()]);
	for (const [i, s] of again) main[i] = s;
	for (const [i, o] of others) mergeEnds((main[i] as State).region, o.region);
	for (const [i, t] of measuredAt)
		rebase((main[i] as State).region, t.refFrame, t.ref);
	main.forEach((s, i) => {
		const smp = s.region.samples;
		if (!smp.some((p) => p.found))
			warnings.push(
				`region ${s.region.name}: the element was never found; its box stays at the region`,
			);
		if ((used[i] as RegionPlan).bounded)
			markClipped(s.region, regions[i] as TrackRegionInput, frame);
		fillSamples(
			smp,
			shapedOf(smp),
			smp.map((p) => p.status === "found" && p.method !== "colour"),
		);
	});
	return main.map((s) => s.region);
}
