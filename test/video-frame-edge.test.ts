import { describe, expect, it } from "vitest";
import type { Track } from "../src/measure/elements.ts";
import { edgeElements, edgeSetup } from "../src/pixel/surface.ts";
import { acquire } from "../src/video/acquire.ts";
import { markClipped } from "../src/video/clip.ts";
import type { Plane } from "../src/video/luma.ts";
import { gridOf, pyramid, score } from "../src/video/match.ts";
import { TemplateModel } from "../src/video/model.ts";
import type { RegionSample, RegionTrack } from "../src/video/samples.ts";
import { grain } from "./synth-frames.ts";

/** A plane of the page grain with a textured block of w x h at (bx, by). */
function plane(width: number, height: number, bx: number, by: number) {
	const data = new Float32Array(width * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const inside = x >= bx && x < bx + 120 && y >= by && y < by + 40;
			data[y * width + x] = inside
				? 40 + 180 * grain(Math.floor((x - bx) / 6), Math.floor((y - by) / 6))
				: 240;
		}
	return { width, height, data } as Plane;
}

describe("an element at the frame edge and in a thin region", () => {
	it("scores the part of a template inside the frame when it may overhang", () => {
		const p = plane(200, 100, 140, 30);
		const ref = plane(200, 100, 40, 30);
		const t = new Float32Array(120 * 40);
		for (let j = 0; j < 40; j++)
			for (let i = 0; i < 120; i++)
				t[j * 120 + i] = ref.data[(30 + j) * 200 + 40 + i] as number;
		const g = gridOf(t, 120, 40);
		expect(score(p, g, 140, 30)).toBeNull();
		expect(score(p, g, 140, 30, 0.5)?.ncc).toBeGreaterThan(0.99);
	});

	it("finds an element far from its last place in a region barely taller than it", () => {
		const ref = pyramid(plane(800, 60, 600, 8));
		const now = pyramid(plane(800, 60, 80, 8));
		const model = new TemplateModel(ref, { x: 594, y: 2, w: 132, h: 52 });
		const area = { x: 0, y: 2, w: 800, h: 54 };
		const pose = { cx: 660, cy: 28, s: 1, blur: 0 };
		const a = acquire(now, model, area, pose, { scale: false, blur: false }, 1);
		expect(a?.judgement.status).toBe("found");
		expect(Math.abs((a?.fit.cx ?? 0) - 140)).toBeLessThan(1);
	});

	it("does not clip a move along a thin region at the sides it does not move towards", () => {
		const samples = Array.from(
			{ length: 10 },
			(_, k) =>
				({
					found: true,
					dx: -20 * Math.min(5, k),
					dy: k % 2 ? 0.2 : -0.2,
					scale: 1,
					clipped: false,
				}) as RegionSample,
		);
		const t: RegionTrack = {
			name: "row",
			box: { x: 200, y: 10, w: 100, h: 20 },
			ref: "first",
			refFrame: 0,
			samples,
			clipped: [],
			lost: [],
		};
		const region = { x: 0, y: 10, w: 400, h: 20 };
		expect(markClipped(t, region, { x: 0, y: 0, w: 500, h: 60 })).toEqual([]);
	});
});

describe("a panel edge that reveals content in place", () => {
	it("is tracked as the element's edge, though it travels far more than the content", () => {
		// The content drifts 16 px left while the panel's edge sweeps 312 px across it.
		const n = 30;
		const lead = (k: number) =>
			568 - 16 * Math.min(1, Math.max(0, (k - 5) / 8));
		const edge = (k: number) =>
			k < 5 ? null : 553 + 313 * (1 - Math.min(1, (k - 5) / 8)) ** 3;
		const track: Track = {
			selectors: ["info"],
			frameMs: 1000 / 60,
			frames: Array.from({ length: n }, (_, k) => ({
				frame: k,
				t: Math.round((k * 1000) / 60),
				scrollY: 0,
				elements: {
					info: [
						{
							index: 0,
							x: lead(k),
							y: 115,
							w: 314,
							h: 290,
							opacity: 1,
							transform: "none",
							filter: "none",
							clipPath: "none",
							color: "",
							backgroundColor: "",
							boxShadow: "none",
						},
					],
				},
			})),
		};
		const setup = edgeSetup(track, "info", 0);
		expect(setup?.axis).toBe("x");
		const edges = Array.from({ length: n }, (_, k) => edge(k));
		const got = edgeElements(
			track,
			"info",
			0,
			setup as NonNullable<typeof setup>,
			edges,
		);
		expect(got).not.toBeNull();
	});
});
