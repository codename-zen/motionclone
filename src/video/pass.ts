import { type Plane, type Rgba, readFrame } from "./luma.ts";
import { type Frame, pyramid } from "./match.ts";
import { changeStats, type RegionSample, sampleBox } from "./samples.ts";
import type { Ends, State } from "./state.ts";
import { shiftOf } from "./state.ts";
import { step } from "./step.ts";

async function frameAt(dir: string, k: number, frames: number, ends: Ends) {
	if (k === 0)
		return { plane: ends.first, f: ends.frames.first, rgba: ends.rgba.first };
	if (k === frames - 1)
		return { plane: ends.last, f: ends.frames.last, rgba: ends.rgba.last };
	const { luma, rgba } = await readFrame(dir, k);
	return { plane: luma, f: pyramid(luma) as Frame, rgba: rgba as Rgba };
}

/** Each state from its reference end of the clip towards the other end, or until `done` says it may stop. */
export async function runPass(
	dir: string,
	frames: number,
	states: State[],
	ends: Ends,
	floor: number,
	done: (s: State, k: number) => boolean = () => false,
) {
	for (const ref of ["first", "last"] as const) {
		let group = states.filter((s) => s.region.ref === ref);
		if (group.length === 0) continue;
		const order = Array.from({ length: frames }, (_, i) =>
			ref === "first" ? i : frames - 1 - i,
		);
		let prev: { k: number; plane: Plane } | null = null;
		for (const k of order) {
			const { plane, f, rgba } = await frameAt(dir, k, frames, ends);
			for (const s of group) {
				step(s, f, rgba, k);
				const box = sampleBox(s.region.box, {
					...(s.region.samples[k] as RegionSample),
					...shiftOf(s, s.pose),
					scale: s.pose.s,
				});
				(s.region.samples[k] as RegionSample).centroid = changeStats(
					plane,
					ends.first,
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
			group = group.filter((s) => !done(s, k));
			if (group.length === 0) break;
		}
	}
}
