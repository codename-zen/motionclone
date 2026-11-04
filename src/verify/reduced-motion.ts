import { resolve } from "node:path";
import { type MovingProperty, readTrack } from "../measure/elements.ts";
import { readCaptureFile } from "../spec/capture-file.ts";
import { elementKey, motionProperties } from "../spec/motion.ts";
import { movement, unitOf } from "./messages.ts";
import type { ReducedMotion } from "./schema.ts";

const keyOf = (m: MovingProperty) =>
	`${elementKey(m.selector, m.index)}.${m.property}`;

const travel = (w: MovingProperty["window"]) =>
	Math.abs(w.thereAndBack ? w.peak - w.from : w.change);

const described = (m: MovingProperty) =>
	`${keyOf(m)} ${movement(m.window.from, m.window.to, unitOf(m.property))} from ${Math.round(m.window.startMs)} ms`;

const cannot = (dir: string, why: string): ReducedMotion => ({
	dir,
	pass: null,
	unchanged: [],
	moved: [],
	message: `reduced-motion check did not run: ${why}`,
});

/**
 * Compare the clone with a second capture taken with prefers-reduced-motion: reduce. It passes when every moving
 * property of the clone other than opacity loses at least half its travel there; fades may stay.
 */
export async function checkReducedMotion(
	cloneDir: string,
	reducedDir: string,
): Promise<ReducedMotion> {
	const dir = resolve(reducedDir);
	let reducedTrack: Awaited<ReturnType<typeof readTrack>>;
	let reduce: string | undefined;
	try {
		reduce = (await readCaptureFile(dir)).options.reducedMotion;
		reducedTrack = await readTrack(dir);
	} catch {
		return cannot(
			dir,
			`${dir} is not a capture directory (no capture.json or track.json)`,
		);
	}
	if (reduce !== "reduce")
		return cannot(
			dir,
			`${dir} was captured without --reduced-motion, so it shows the normal motion; capture the clone again with --reduced-motion`,
		);
	const motions = motionProperties(await readTrack(cloneDir));
	if (motions.length === 0)
		return cannot(
			dir,
			"no tracked element of the clone moves, so there is no motion to reduce; track the moving elements with --track",
		);
	const reduced = motionProperties(reducedTrack);
	const byKey = new Map(reduced.map((m) => [keyOf(m), m]));
	const unchanged = motions.filter((m) => {
		if (m.property === "opacity") return false;
		const r = byKey.get(keyOf(m));
		return r !== undefined && travel(r.window) >= 0.5 * travel(m.window);
	});
	const moved = reduced.map(described);
	const pass = unchanged.length === 0;
	return {
		dir,
		pass,
		unchanged: unchanged.map(keyOf),
		moved,
		message: pass
			? `reduced motion passes: with prefers-reduced-motion: reduce, ${moved.length === 0 ? "nothing moves" : `only ${moved.length} propert${moved.length === 1 ? "y moves" : "ies move"}, each under half its normal travel or an opacity fade`} (${motions.length} moving propert${motions.length === 1 ? "y" : "ies"} without it)`
			: `reduced motion fails: ${unchanged.length} of ${motions.length} moving properties keep at least half their travel with prefers-reduced-motion: reduce (${unchanged.map(keyOf).join(", ")}); add a @media (prefers-reduced-motion: reduce) rule that removes or shortens the movement`,
	};
}
