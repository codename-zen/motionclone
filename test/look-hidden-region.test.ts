import { describe, expect, it } from "vitest";
import { regionsAt } from "../src/look/file.ts";
import { LookFile, type PixelLook } from "../src/look/schema.ts";
import { draftLook } from "../src/spec/look.ts";
import { checkLookRow } from "../src/verify/look-rows.ts";
import { element } from "./fake-capture.ts";

const CLIP = { x: 0, y: 0, width: 400, height: 300 };
const PANEL = { x: 250, y: 0, w: 150, h: 300 };

const pixels = (panel: boolean): PixelLook => ({
	background: "#ffffff",
	text: null,
	palette: [],
	surfaces: [],
	regions: panel
		? [
				{
					key: "info[0]",
					box: PANEL,
					background: "#f0f0f0",
					palette: [],
					type: [],
					text: null,
					textShare: null,
				},
			]
		: [],
	blocks: [],
	bands: [],
	type: [],
	lines: [],
	outsideText: null,
	outsideTextShare: null,
	panel: null,
});

// A side panel closed at the start and at the end, open on the plateau between.
const look = LookFile.parse({
	version: 1,
	source: "video",
	screen: { width: 400, height: 300 },
	states: [
		{
			label: "first",
			frame: 12,
			t: 200,
			rest: true,
			page: null,
			pixels: pixels(false),
		},
		{
			label: "plateau",
			frame: 89,
			t: 1483,
			rest: true,
			page: null,
			pixels: pixels(true),
		},
		{
			label: "last",
			frame: 400,
			t: 6667,
			rest: true,
			page: null,
			pixels: pixels(false),
		},
	],
	summary: {
		palette: [],
		textColours: [],
		typeScale: [],
		radii: [],
		spacing: [],
	},
	warnings: [],
});

describe("a region the last rest frame does not show", () => {
	it("has no look on a frame where it is hidden", () => {
		const frame = {
			frame: 0,
			t: 0,
			scrollY: 0,
			elements: {
				info: [element({ ...PANEL, opacity: 0 })],
				toolbar: [element({ x: 0, y: 0, w: 100, h: 30 })],
			},
		};
		expect(regionsAt(frame).map((r) => r.key)).toEqual(["toolbar[0]"]);
	});

	it("gets its rows from the latest rest frame that shows it", () => {
		const rows = draftLook(look, CLIP).rows.filter((r) =>
			r.id.startsWith("info[0]"),
		);
		expect(rows.map((r) => [r.id, r.label, r.colour, r.state])).toEqual([
			[
				"info[0].look.background",
				"info[0] background (rest at 1483 ms)",
				"#f0f0f0",
				{ name: "rest", frame: 89, t: 1483 },
			],
		]);
	});

	it("says the clone's element is hidden, not untracked, when the clone does not show it", () => {
		const row = draftLook(look, CLIP).rows.find(
			(r) => r.id === "info[0].look.background",
		);
		if (!row) throw new Error("no info row");
		const clone = {
			styles: null,
			pixels: pixels(false),
			screen: { x: 0, y: 0, w: 400, h: 300 },
			target: (selector: string, index: number) => ({ selector, index }),
			tracked: new Set(["info[0]"]),
			t: 1483,
			refStylesAt: null,
			stylesAt: null,
		};
		expect(checkLookRow(row, clone).message).toBe(
			"info[0] background (rest at 1483 ms): info[0] is outside the clone's frame or hidden at 1483 ms; the reference shows it there",
		);
		expect(checkLookRow(row, { ...clone, pixels: pixels(true) }).pass).toBe(
			true,
		);
	});
});
