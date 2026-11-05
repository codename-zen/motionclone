import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Track } from "../src/measure/elements.ts";
import { CLONE_EDGES, withCloneEdges } from "../src/pixel/clone-edges.ts";
import { writeFrames } from "./synth-frames.ts";

const N = 20;
// A dark sheet whose top edge slides from y 60 to y 140; the tracked content rides 20 px under it.
const top = (k: number) => 60 + 80 * Math.min(1, k / 10);
const box = (k: number, x = 20) => ({
	index: 0,
	x,
	y: top(k) + 20,
	w: 160,
	h: 30,
	opacity: 1,
	transform: "none",
	filter: "none",
	clipPath: "none",
	color: "",
	backgroundColor: "",
	boxShadow: "none",
});
const track = (edge: boolean): Track => ({
	selectors: edge ? ["sheet", "sheet::edge"] : ["sheet"],
	frameMs: 1000 / 60,
	frames: Array.from({ length: N }, (_, k) => ({
		frame: k,
		t: Math.round((k * 1000) / 60),
		scrollY: 0,
		elements: {
			sheet: [box(k)],
			...(edge ? { "sheet::edge": [{ ...box(k), y: top(k), h: 50 }] } : {}),
		},
	})),
});

describe("the clone's surface edges", () => {
	let dir: string;
	beforeAll(async () => {
		dir = await writeFrames("clone-edges", 200, 240, N, (k, _x, y) =>
			y >= top(k) ? 40 : 240,
		);
	});
	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("are written beside the verdict, frame by frame", async () => {
		const clip = { x: 0, y: 0, width: 200, height: 240 };
		await withCloneEdges(dir, track(false), clip, track(true), clip, dir);
		const file = JSON.parse(await readFile(join(dir, CLONE_EDGES), "utf8"));
		const frames = file.edges[0].frames as { y: number | null }[];
		expect(file.edges[0].selector).toBe("sheet::edge");
		expect(frames).toHaveLength(N);
		expect(Math.abs((frames[15]?.y ?? 0) - 140)).toBeLessThan(1.5);
	});
});
