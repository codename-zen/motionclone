import { describe, expect, it } from "vitest";
import {
	deltaE2000,
	deltaEHex,
	hexToLab,
	labToHex,
	over,
} from "../src/look/colour.ts";
import { restStates } from "../src/look/rest.ts";

describe("colour", () => {
	// Reference pairs from Sharma, Wu and Dalal's CIEDE2000 test data.
	it.each([
		[{ l: 50, a: 2.6772, b: -79.7751 }, { l: 50, a: 0, b: -82.7485 }, 2.0425],
		[{ l: 50, a: 0, b: 0 }, { l: 50, a: -1, b: 2 }, 2.3669],
		[{ l: 50, a: 2.49, b: -0.001 }, { l: 50, a: -2.49, b: 0.0009 }, 7.1792],
		[
			{ l: 60.2574, a: -34.0099, b: 36.2677 },
			{ l: 60.4626, a: -34.1751, b: 39.4387 },
			1.2644,
		],
	])("CIEDE2000 of %o and %o is %d", (p, q, want) => {
		expect(deltaE2000(p, q)).toBeCloseTo(want, 4);
	});

	it("round-trips hex through Lab and composites alpha", () => {
		for (const hex of ["#ffffff", "#000000", "#4f46e5", "#eef2ff"])
			expect(labToHex(hexToLab(hex))).toBe(hex);
		expect(over("#00000080", "#ffffff")).toBe("#7f7f7f");
		expect(deltaEHex("#ffffff", "#f4f7f1")).toBeCloseTo(4.1, 1);
	});
});

describe("rest states", () => {
	it("keeps still runs before and between changes, not short pauses", () => {
		const still = (n: number) => Array(n).fill(0);
		const move = (n: number) => Array(n).fill(5);
		const activity = [
			...still(10),
			...move(5),
			...still(20),
			...move(5),
			...still(2),
			...move(3),
			...still(10),
		];
		expect(restStates(activity, 10)).toEqual([
			{ label: "first", frame: 5, rest: true },
			{ label: "plateau", frame: 24, rest: true },
			{ label: "last", frame: 54, rest: true },
		]);
	});
});
