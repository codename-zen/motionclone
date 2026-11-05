import { describe, expect, it } from "vitest";
import type { PageStyles, TypeLine } from "../src/look/schema.ts";
import { ranked } from "../src/look/type.ts";
import { rowsOf } from "../src/spec/look-draft.ts";
import { typeVerdict } from "../src/verify/look-type.ts";

const SCREEN = { x: 0, y: 0, w: 400, h: 300 };
const line = (y: number, cap: number): TypeLine => ({
	x: 0.1,
	y,
	w: 0.5,
	cap,
	basis: "capitals",
	glyphs: 6,
});
const REF = [line(0.2, 12), line(0.4, 12)];
const [row] = rowsOf("pixels", [
	{
		id: "look.type#1",
		label: "text cap height",
		measure: "text-height",
		px: 12,
		lines: REF.map((l) => ranked(l, REF)),
	},
]);
if (!row) throw new Error("no row");

const styles = (text: string, y: number): PageStyles =>
	({
		background: "#ffffff",
		target: "body",
		tracked: {},
		truncated: false,
		elements: [{ box: { x: 30, y, w: 250, h: 20 }, text, textLength: 5 }],
	}) as unknown as PageStyles;

describe("type rows name their lines", () => {
	it("a failing row names the off-size line in the reference and in the clone", () => {
		const v = typeVerdict(row, [line(0.21, 14.4), line(0.41, 12.1)], {
			screen: SCREEN,
			refStyles: null,
			cloneStyles: null,
		});
		expect(v.pass).toBe(false);
		expect(v.message).toBe(
			"text cap height 14.4 px, want 12 px (+20 %, allowed ±8 %); the line at x 40, baseline y 60 px (12 px) reads 14.4 px in the clone at x 40, baseline y 63 px",
		);
		expect(v.lines.map((p) => [p.reference.y, p.clone?.y])).toEqual([
			[60, 63],
			[120, 123],
		]);
	});

	it("adds the words of a line when a style record has them", () => {
		const v = typeVerdict(row, [line(0.2, 12), line(0.4, 12.1)], {
			screen: SCREEN,
			refStyles: styles("Lunch", 45),
			cloneStyles: styles("Dinner", 45),
		});
		expect(v.pass).toBe(true);
		// The median pair is the second line, which no element names.
		expect(v.message).toBe(
			"text cap height 12.1 px matches 12 px, line at x 40, baseline y 120 px (clone line at x 40, baseline y 120 px)",
		);
		expect(v.lines[0]?.reference.text).toBe("Lunch");
		expect(v.lines[0]?.clone?.text).toBe("Dinner");
	});

	it("a row with no clone line in place names the reference line", () => {
		const v = typeVerdict(row, [], {
			screen: SCREEN,
			refStyles: null,
			cloneStyles: null,
		});
		expect(v.comparable).toBe(false);
		expect(v.message).toBe(
			"text cap height: not comparable: no matching text line in the clone; the reference line is at x 40, baseline y 60 px",
		);
	});
});
