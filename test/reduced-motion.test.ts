import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrackFrame } from "../src/capture/types.ts";
import { checkReducedMotion } from "../src/verify/reduced-motion.ts";

const FRAME_MS = 20;

let root: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-reduced-"));
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

const frame = (k: number, y: number): TrackFrame => ({
	frame: k,
	t: k * FRAME_MS,
	scrollY: 0,
	elements: {
		".sheet": [
			{
				index: 0,
				x: 0,
				y: 0,
				w: 100,
				h: 100,
				opacity: 1,
				transform: `matrix(1, 0, 0, 1, 0, ${y})`,
				filter: "none",
				clipPath: "none",
				color: "",
				backgroundColor: "",
				boxShadow: "none",
			},
		],
	},
});

/** A capture directory whose sheet sits at y(k) on frame k. */
async function capture(
	name: string,
	y: (k: number) => number,
	reduce: boolean,
): Promise<string> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	const frames = Array.from({ length: 40 }, (_, k) => frame(k, y(k)));
	await writeFile(
		join(dir, "track.json"),
		JSON.stringify({ selectors: [".sheet"], frameMs: FRAME_MS, frames }),
	);
	await writeFile(
		join(dir, "capture.json"),
		JSON.stringify({
			options: reduce ? { reducedMotion: "reduce" } : {},
			triggerAtMs: 0,
			frames: frames.length,
			frameMs: FRAME_MS,
		}),
	);
	return dir;
}

const slide = (from: number, to: number, start: number, frames: number) => {
	return (k: number) =>
		k <= start
			? from
			: k >= start + frames
				? to
				: from + ((to - from) * (k - start)) / frames;
};

describe("checkReducedMotion", () => {
	it("treats a change that completes within one frame as a state change", async () => {
		const normal = await capture("jump-normal", slide(0, 400, 5, 10), false);
		const reduced = await capture(
			"jump-reduced",
			(k) => (k < 6 ? 0 : 400),
			true,
		);
		const r = await checkReducedMotion(normal, reduced);
		expect(r.pass).toBe(true);
		expect(r.unchanged).toEqual([]);
		expect(r.moved).toEqual([]);
	});

	it("still fails when the reduced capture moves through intermediate frames", async () => {
		const normal = await capture("slide-normal", slide(0, 400, 5, 10), false);
		const reduced = await capture("slide-reduced", slide(0, 400, 5, 10), true);
		const r = await checkReducedMotion(normal, reduced);
		expect(r.pass).toBe(false);
		expect(r.unchanged).toEqual([".sheet[0].translateY"]);
	});
});
