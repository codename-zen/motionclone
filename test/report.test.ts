import { describe, expect, it } from "vitest";
import { renderReport } from "../src/report/report.ts";
import { type RowVerdict, Verdict } from "../src/verify/schema.ts";

const HEADER =
	"| id | result | start | duration | stagger gap | easing | overshoot | distance |";
const metric = {
	want: 100,
	got: 104,
	diff: 4,
	tol: 20,
	unit: "ms",
	pass: true,
};

const row = (
	id: string,
	advisory: string | null,
	notes: string[] = [],
): Partial<RowVerdict> => ({
	id,
	kind: "motion",
	selector: ".card",
	index: 0,
	property: id.split(".").at(-1) ?? null,
	pass: true,
	metrics: { start: metric, duration: metric },
	failures: [],
	message: "",
	focusMs: [],
	notes,
	advisory,
});

const verdict = (rows: Partial<RowVerdict>[]) => {
	const advisory = rows.filter((r) => r.advisory !== null).length;
	return Verdict.parse({
		version: 1,
		referenceDir: "ref",
		cloneDir: "clone",
		fidelity: "motion",
		setupErrors: [],
		rows,
		pixel: null,
		warnings: [],
		coverage: { source: "video", elements: [], warnings: [] },
		summary: {
			rows: rows.length,
			passed: rows.length - advisory,
			failed: 0,
			advisory,
		},
		pass: true,
	});
};

const count = (md: string, line: string) =>
	md.split("\n").filter((l) => l === line).length;
const headings = (md: string) =>
	md.split("\n").filter((l) => l.startsWith("## "));

describe("report.md", () => {
	it("prints the advisory table and each advisory row once", () => {
		const md = renderReport(
			verdict([
				row("card[0].x", null),
				row("card[0].blur", "2 reliable samples in the motion"),
				row("card[0].scale", "3 reliable samples in the motion"),
			]),
		);
		expect(count(md, "## Advisory (low confidence)")).toBe(1);
		// One header for the checked table, one for the advisory table.
		expect(count(md, HEADER)).toBe(2);
		for (const id of ["card[0].x", "card[0].blur", "card[0].scale"])
			expect(
				md.split("\n").filter((l) => l.startsWith(`| ${id} |`)),
			).toHaveLength(1);
		expect(
			md.split("\n").filter((l) => l.startsWith("- card[0].blur:")),
		).toHaveLength(1);
	});

	it("leaves out the checked table when every row is advisory", () => {
		const md = renderReport(
			verdict([row("card[0].blur", "2 reliable samples in the motion")]),
		);
		expect(count(md, HEADER)).toBe(1);
		expect(headings(md)).toEqual(["## Advisory (low confidence)"]);
	});

	it("omits empty sections and prints each section once", () => {
		const plain = renderReport(verdict([row("card[0].x", null)]));
		expect(headings(plain)).toEqual([]);
		expect(plain).not.toContain("## Partly observed");
		expect(plain).not.toContain("## Advisory");
		expect(plain).not.toContain("## Not measured");
		const noted = renderReport(
			verdict([
				row("card[0].x", null, ["start not observed"]),
				row("card[0].y", null),
			]),
		);
		expect(headings(noted)).toEqual(["## Partly observed"]);
		expect(noted).toContain("- card[0].x: start not observed");
	});
});
