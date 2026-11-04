import type { Plane, Rgba } from "./luma.ts";
import { type Frame, pyramid } from "./match.ts";
import { changeStats, type RegionSample, sampleBox } from "./samples.ts";
import { type Anchor, restart, type State, shiftOf } from "./state.ts";
import { step } from "./step.ts";

/** Reads a frame for tracking; anchors are reused. */
export type FrameSource = (
	k: number,
) => Promise<{ plane: Plane; f: Frame; rgba: Rgba }>;

export function frameSource(
	read: (k: number) => Promise<{ luma: Plane; rgba: Rgba }>,
	anchors: Map<number, Anchor>,
): FrameSource {
	return async (k) => {
		const a = anchors.get(k);
		if (a) return { plane: a.plane, f: a.frame, rgba: a.rgba };
		const { luma, rgba } = await read(k);
		return { plane: luma, f: pyramid(luma), rgba };
	};
}

/** `done` says a state may stop tracking at frame k while moving in direction `dir`. */
export type Done = (s: State, k: number, dir: 1 | -1) => boolean;

/**
 * Each state from its reference frame to the end of the clip, then from the reference frame back to its start.
 * Change statistics compare each frame with frame 0 (`base`) and with the frame tracked before it.
 */
export async function runPass(
	frames: number,
	states: State[],
	source: FrameSource,
	base: Plane,
	floor: number,
	done: Done = () => false,
) {
	const refs = [...new Set(states.map((s) => s.region.refFrame))];
	for (const ref of refs)
		for (const dir of [1, -1] as const) {
			let group = states.filter((s) => s.region.refFrame === ref);
			// From the last frame the backward sweep simply continues the forward one.
			if (dir === -1 && ref < frames - 1) for (const s of group) restart(s);
			let prev: { k: number; plane: Plane } | null =
				dir === -1 ? { k: ref, plane: (await source(ref)).plane } : null;
			for (let k = dir === 1 ? ref : ref - 1; k >= 0 && k < frames; k += dir) {
				const { plane, f, rgba } = await source(k);
				for (const s of group) {
					step(s, f, rgba, k);
					if (k === ref) s.start = { ...s.pose };
					const box = sampleBox(s.region.box, {
						...(s.region.samples[k] as RegionSample),
						...shiftOf(s, s.pose),
						scale: s.pose.s,
					});
					(s.region.samples[k] as RegionSample).centroid = changeStats(
						plane,
						base,
						box,
						floor,
					).centroid;
					if (prev) {
						const [later, earlier] =
							prev.k > k ? [prev, plane] : [{ k, plane }, prev.plane];
						const ls = s.region.samples[later.k] as RegionSample;
						ls.energy = changeStats(
							later.plane,
							earlier,
							sampleBox(s.region.box, ls),
							floor,
						).mean;
					}
				}
				prev = { k, plane };
				group = group.filter((s) => !done(s, k, dir));
				if (group.length === 0) break;
			}
		}
}
