import { describe, expect, it } from "vitest";
import { cropWarnings } from "../src/capture/crop-watch.ts";
import type { TrackFrame } from "../src/capture/types.ts";
import { element } from "./fake-capture.ts";

const CROP = { x: 0, y: 0, width: 100, height: 200 };
const MS = 20;
// A strip that slides off the bottom on frames 5 to 9 and comes back.
const off = (k: number) => k >= 5 && k < 10;

const frames = (
	sel: string,
	at: (k: number) => { y: number; opacity?: number },
): TrackFrame[] =>
	Array.from({ length: 15 }, (_, k) => ({
		frame: k,
		t: k * MS,
		scrollY: 0,
		elements: { [sel]: [element({ x: 0, w: 100, h: 30, ...at(k) })] },
	}));

const clone = frames("#strip", (k) => ({ y: off(k) ? 190 : 120 }));
const ref = (hidden: boolean) => ({
	clip: CROP,
	track: {
		selectors: ["strip"],
		frameMs: MS,
		frames: frames("strip", (k) => ({
			y: 118,
			opacity: hidden && off(k) ? 0 : 1,
		})),
	},
});

describe("crop warnings", () => {
	it("say nothing when the reference's element leaves the screen at the same time", () => {
		expect(cropWarnings(clone, CROP, ref(true))).toEqual([]);
	});

	it("name the reference element that stays in view", () => {
		expect(cropWarnings(clone, CROP, ref(false))).toEqual([
			"tracked element #strip[0] is partly or fully outside the crop from 100 ms to 200 ms, while the reference shows strip[0] in full there; the frames do not show all of #strip[0]",
		]);
	});

	it("say plainly that leaving on purpose is fine without a reference", () => {
		expect(cropWarnings(clone, CROP, null)).toEqual([
			"tracked element #strip[0] is partly or fully outside the crop from 100 ms to 200 ms; the frames do not show all of it. If it leaves the screen on purpose, ignore this",
		]);
	});
});
