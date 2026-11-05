import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { edgesIn } from "../src/pixel/edge.ts";
import { type EdgeCandidate, followEdge } from "../src/pixel/edge-follow.ts";

const step = (pos: number, s = -40): EdgeCandidate => ({
	pos,
	step: s,
	line: false,
});
const span = (near: number) => ({ near, far: near + 300 });

describe("following one surface edge", () => {
	it("stays on its edge when its contrast dips and a neighbouring edge shows instead", () => {
		// The element moves from 276 to 120; its own edge (at its lead) drops out on some frames, while another edge
		// 17 px further in always shows. The old nearest-edge pick jumped to it and read an overshoot.
		const leads = [
			276, 276, 276, 248, 206, 177, 155, 140, 131, 126, 122, 121, 120, 120, 120,
		];
		const dips = new Set([4, 7, 9]);
		const cands = leads.map((l, k) => [
			...(dips.has(k) ? [] : [step(l)]),
			step(l + 17, -30),
		]);
		const got = followEdge(cands, leads.map(span));
		leads.forEach((l, k) => {
			if (got[k] !== null)
				expect(Math.abs((got[k] as number) - l)).toBeLessThan(1);
		});
		expect(got.filter((g) => g === null)).toHaveLength(dips.size);
	});

	it("follows an edge that sweeps across content that stays in place", () => {
		const edge = [866, 866, 800, 700, 620, 575, 558, 553, 553, 553];
		const cands = edge.map((e, k) => (k < 2 ? [] : [step(e)]));
		const got = followEdge(
			cands,
			edge.map(() => span(552)),
		);
		expect(got.slice(2)).toEqual(edge.slice(2));
	});

	it("follows a trailing edge that speeds up as its content slows down", () => {
		const edge = [
			96, 98, 102, 108, 118, 131, 150, 176, 211, 256, 313, 370, 418, 454, 481,
			500,
		];
		const lead = [
			147, 216, 273, 326, 371, 409, 441, 467, 488, 504, 517, 526, 533, 537, 539,
			540,
		];
		const got = followEdge(
			edge.map((e) => [step(e, 238)]),
			lead.map((n) => ({ near: n, far: n + 50 })),
		);
		expect(got).toEqual(edge);
	});

	it("follows a leading edge that leaves its rest faster than its content", () => {
		const edge = [536, 536, 536, 426, 311, 232, 182, 150, 130, 117, 109, 103];
		const lead = [540, 540, 540, 481, 413, 354, 304, 260, 224, 195, 169, 149];
		const got = followEdge(
			edge.map((e) => [step(e, 238)]),
			lead.map((n) => ({ near: n, far: n + 50 })),
		);
		expect(got).toEqual(edge);
	});

	it("reads nothing on frames without a reading of the element", () => {
		const cands = [[step(100)], [step(100)], [step(140)], [step(100)]];
		const got = followEdge(cands, [span(100), span(100), null, span(100)]);
		expect(got[2]).toBeNull();
	});
});

describe("divider lines", () => {
	it("finds a faint hairline between two areas of the same colour, and no step there", () => {
		const png = new PNG({ width: 120, height: 60 });
		for (let y = 0; y < 60; y++)
			for (let x = 0; x < 120; x++) {
				// A 3 px line, 10 levels darker than the white on both sides.
				const v = x >= 60 && x < 63 ? 245 : 255;
				const o = (y * 120 + x) * 4;
				png.data.fill(v, o, o + 3);
				png.data[o + 3] = 255;
			}
		const edges = edgesIn(png, { axis: "x", a0: 0, a1: 60, b0: 10, b1: 110 });
		expect(edges).toHaveLength(1);
		expect(edges[0]?.line).toBe(true);
		expect(Math.abs((edges[0]?.pos ?? 0) - 61.5)).toBeLessThan(1);
	});
});
