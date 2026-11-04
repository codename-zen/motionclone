import { describe, expect, it } from "vitest";
import { markLost } from "../src/video/lost.ts";
import type { RegionSample, RegionTrack } from "../src/video/samples.ts";
import type { Scan } from "../src/video/scan.ts";

const FRAMES = 12;
// The region ends inside the frame on its right and bottom, and the element is a small box inside it.
const REGION = { x: 0, y: 0, w: 16, h: 16 };
const FRAME = { x: 0, y: 0, w: 32, h: 32 };
const BOX = { x: 2, y: 2, w: 4, h: 4 };

/** A 16x16 clip whose region changes on the given frames, at quarter resolution. */
function scanOf(moving: number[]): Scan {
	let v = 0;
	const coarse = Array.from({ length: FRAMES }, (_, k) => {
		if (moving.includes(k)) v += 40;
		return new Uint8Array(16).fill(v % 256);
	});
	const plane = { width: 16, height: 16, data: new Float32Array(256) };
	return {
		frames: FRAMES,
		width: 4,
		height: 4,
		coarse,
		first: plane,
		last: plane,
	};
}

/** Found everywhere but `lost`; after the last lost frame the element sits `shift` px lower. */
function trackOf(
	lost: number[],
	clipped: number[] = [],
	shift = 0,
): RegionTrack {
	const end = Math.max(...lost);
	const samples = Array.from(
		{ length: FRAMES },
		(_, k) =>
			({
				found: !lost.includes(k),
				clipped: clipped.includes(k),
				scale: 1,
				dx: 0,
				dy: k > end ? shift : 0,
			}) as RegionSample,
	);
	return {
		name: "sheet",
		box: BOX,
		ref: "first",
		refFrame: 0,
		samples,
		clipped: [],
		lost: [],
	};
}

const range = (a: number, b: number) =>
	Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe("lost transitions", () => {
	it("reports a gap of three or more frames where the element moved while the region changed", () => {
		const t = trackOf(range(3, 6), [], 6);
		expect(markLost(t, scanOf([4, 5]), REGION, FRAME, 3, false)).toEqual([
			{ from: 3, to: 6 },
		]);
		expect(t.lost).toEqual([{ from: 3, to: 6 }]);
	});

	it("ignores short gaps, still gaps, covered elements and clipped frames", () => {
		expect(
			markLost(trackOf([4, 5], [], 6), scanOf([4]), REGION, FRAME, 3, false),
		).toEqual([]);
		expect(
			markLost(
				trackOf(range(3, 6), [], 6),
				scanOf([9]),
				REGION,
				FRAME,
				3,
				false,
			),
		).toEqual([]);
		expect(
			markLost(trackOf(range(3, 6)), scanOf([4]), REGION, FRAME, 3, false),
		).toEqual([]);
		expect(
			markLost(
				trackOf(range(3, 6), range(3, 6)),
				scanOf([4]),
				REGION,
				FRAME,
				3,
				true,
			),
		).toEqual([]);
	});

	it("ignores an element that comes back past the region edge", () => {
		expect(
			markLost(
				trackOf(range(3, 6), [], 40),
				scanOf([4]),
				REGION,
				FRAME,
				3,
				false,
			),
		).toEqual([]);
	});

	it("reports gaps at the clip ends only for a region that bounds its element", () => {
		const t = () => trackOf(range(7, 11));
		expect(markLost(t(), scanOf([8]), REGION, FRAME, 3, false)).toEqual([]);
		expect(markLost(t(), scanOf([8]), REGION, FRAME, 3, true)).toEqual([
			{ from: 7, to: 11 },
		]);
	});
});
