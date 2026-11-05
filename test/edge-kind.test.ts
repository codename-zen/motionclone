import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Track } from "../src/measure/elements.ts";
import { EDGE, edgeElements, edgeSetup } from "../src/pixel/surface.ts";
import { edgeWarning, trackSurfaceEdges } from "../src/video/edges.ts";
import { element } from "./fake-capture.ts";
import { writeFrames } from "./synth-frames.ts";

const FRAMES = 40;
const W = 200;
const H = 400;
const move = (k: number) => Math.min(1, Math.max(0, (k - 10) / 15));
// Content (an event in a list) moves 60 px with rules that scroll along with it; the dark panel below the list
// moves 100 px, apart from the content, as a split view's divider does.
const lead = (k: number) => 100 + 60 * move(k);
const panel = (k: number) => 220 + 100 * move(k);
const rules = (k: number) => [lead(k) - 30, lead(k) + 40];

describe("the surface edge behind content with rules of its own", () => {
	it("follows the panel edge when the lines nearest the content ride on it", async () => {
		const dir = await writeFrames("edge-kind", W, H, FRAMES, (k, _x, y) => {
			if (y >= panel(k)) return 30;
			return rules(k).some((r) => y >= r && y < r + 3) ? 230 : 240;
		});
		try {
			const track: Track = {
				selectors: ["lunch"],
				frameMs: 1000 / 30,
				frames: Array.from({ length: FRAMES }, (_, k) => ({
					frame: k,
					t: (k * 1000) / 30,
					scrollY: 0,
					elements: {
						lunch: [element({ x: 20, y: lead(k), w: 160, h: 100 })],
					},
				})),
			};
			const warnings: string[] = [];
			const out = await trackSurfaceEdges(
				dir,
				track,
				{ x: 0, y: 0, width: W, height: H },
				warnings,
			);
			expect(warnings).toEqual([edgeWarning("lunch", 0)]);
			const bottom = (k: number) => {
				const e = out.frames[k]?.elements[`lunch${EDGE}`]?.[0];
				return e ? e.y + e.h : null;
			};
			expect(bottom(0)).toBeCloseTo(panel(0), 0);
			expect(bottom(FRAMES - 1)).toBeCloseTo(panel(FRAMES - 1), 0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("lines of the content picked up one after another", () => {
	it("ride on the element, so they are not its surface edge", () => {
		// A rule 60 px below the content's top rides with it; after it scrolls away the follower starts again on the
		// next rule, 50 px below: each stretch keeps its offset, so together they only look like an edge moving apart.
		const track: Track = {
			selectors: ["lunch"],
			frameMs: 1000 / 30,
			frames: Array.from({ length: 60 }, (_, k) => ({
				frame: k,
				t: (k * 1000) / 30,
				scrollY: 0,
				elements: {
					lunch: [element({ x: 20, y: lead(k), w: 160, h: 100 })],
				},
			})),
		};
		const edges = track.frames.map((_, k) =>
			k <= 30 ? lead(k) + 60 : k < 35 ? null : lead(k) + 50,
		);
		const setup = edgeSetup(track, "lunch", 0);
		if (!setup) throw new Error("no setup");
		expect(edgeElements(track, "lunch", 0, setup, edges)).toBeNull();
	});
});
