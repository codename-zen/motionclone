import { describe, expect, it } from "vitest";
import type { Series } from "../src/measure/series.ts";
import { crossCheck } from "../src/spec/cross-check.ts";
import { bezierEasing } from "../src/spec/easing.ts";
import { SpecRow } from "../src/spec/schema.ts";
import { bezierCurve } from "./synth.ts";

const FRAME_MS = 1000 / 57;
const EASE = [0.25, 0.1, 0.25, 1] as const;
const EMPHASIZED = [0.2, 0, 0, 1] as const;

const row = (
	property: string,
	startMs: number,
	durationMs: number,
	p: readonly [number, number, number, number],
	confidence: "high" | "medium" | "low",
	from = property === "progress" ? 0 : 0.98,
	to = property === "progress" ? 1 : 0.22,
) =>
	SpecRow.parse({
		id: `header[0].${property}`,
		selector: "header",
		index: 0,
		property,
		from,
		to,
		fromObserved: property === "progress",
		startMs,
		durationMs,
		easing: bezierEasing(p),
		overshoot: 0,
		relativeDistance: null,
		source: "measured",
		confidence,
		support: { samples: 12, rmse: 0.004, observed: 1, quality: null, weak: [] },
		rmse: 0.004,
		stagger: null,
	});

// One reading per frame of a timed curve, with optional reading noise alternating in sign.
const readings = (
	p: readonly [number, number, number, number],
	startMs: number,
	durationMs: number,
	noise = 0,
): Series => {
	const curve = bezierCurve(p, startMs, durationMs);
	const out: Series = [];
	for (let k = 30; k * FRAME_MS < startMs + durationMs + 300; k++) {
		const t = Math.round(k * FRAME_MS);
		out.push([t, curve(t) + (k % 2 ? noise : -noise)]);
	}
	return out;
};

// The dim as the pixels show it: 650 ms over 272 ms, ease.
const check = (o: SpecRow[], noise = 0) => {
	const p = row("progress", 650, 272, EASE, "high");
	crossCheck(
		o,
		[{ row: p, series: readings(EASE, 650, 272, noise) }],
		FRAME_MS,
	);
	return p;
};

describe("cross-check of a tracker opacity row against pixel progress", () => {
	it("drops a confidently wrong row to low and names both measurements", () => {
		// The tracker's reading of a real dim: 675 ms over 339 ms, high.
		const o = row("opacity", 675, 339, EMPHASIZED, "high");
		const blur = row("blur", 675, 339, EMPHASIZED, "high", 4, 0);
		blur.id = "header[0].blur";
		const p = check([o, blur]);
		expect(o.confidence).toBe("low");
		const note = o.notes.find((n) => n.startsWith("pixel progress disagrees"));
		expect(note).toContain("675 ms over 339 ms");
		expect(note).toContain("650 ms over 272 ms");
		expect(o.support?.weak.join(" ")).toContain("pixel progress disagrees");
		expect(blur.confidence).toBe("low");
		expect(blur.notes.at(-1)).toContain("timing shared with header[0].opacity");
		expect(p.notes.at(-1)).toBe("disagrees with header[0].opacity");
	});

	it("caps a disagreeing row at medium when the pixels do not clearly fit better", () => {
		// 310 ms instead of 272: curves 0.078 apart, but with readings 0.04 off either way the row's curve sits at
		// rms 0.061 against 0.040 for the pixel curve, short of twice as far.
		const o = row("opacity", 650, 310, EASE, "high");
		check([o], 0.04);
		expect(o.confidence).toBe("medium");
		expect(o.notes.at(-1)).toContain("pixel progress disagrees");
	});

	it("flags a start more than a frame plus 20 ms away, even when the curves stay close", () => {
		// A slow linear change: 40 ms moves the curve by only 0.02.
		const linear = [0, 0, 1, 1] as const;
		const p = row("progress", 650, 2000, linear, "high");
		const o = row("opacity", 690, 2000, linear, "high");
		crossCheck(
			[o],
			[{ row: p, series: readings(linear, 650, 2000) }],
			FRAME_MS,
		);
		expect(o.confidence).toBe("medium");
		expect(o.notes.at(-1)).toContain("start gap 40 ms, curve gap 0.02");
	});

	it("raises an agreeing medium row to high and keeps a high one", () => {
		const medium = row("opacity", 655, 268, EASE, "medium");
		check([medium]);
		expect(medium.confidence).toBe("high");
		expect(medium.notes.at(-1)).toContain("pixel progress agrees");
		const high = row("opacity", 650, 272, EASE, "high");
		check([high]);
		expect(high.confidence).toBe("high");
	});

	it("leaves rows of other elements and other windows alone", () => {
		const later = row("opacity", 1500, 260, EASE, "high");
		const other = row("opacity", 675, 339, EMPHASIZED, "high");
		other.selector = "card";
		check([later, other]);
		expect(later.confidence).toBe("high");
		expect(other.confidence).toBe("high");
		expect([...later.notes, ...other.notes]).toEqual([]);
	});
});
