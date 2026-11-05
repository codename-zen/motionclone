import { describe, expect, it } from "vitest";
import { splitAtRests } from "../src/measure/segments.ts";
import type { Series } from "../src/measure/series.ts";

const FRAME = 1000 / 60;
const ramp = (t: number, a: number, ms: number) =>
	Math.min(1, Math.max(0, (t - a) / ms));
/** Readings on 60 fps frames up to `ms`, left out where `skip` says so. */
const series = (
	v: (t: number) => number,
	ms: number,
	skip: (t: number) => boolean = () => false,
): Series =>
	Array.from({ length: Math.round(ms / FRAME) }, (_, k) => k * FRAME)
		.filter((t) => !skip(t))
		.map((t) => [t, v(t)]);
const span = (s: Series) => [s[0]?.[0] ?? 0, s.at(-1)?.[0] ?? 0];

describe("motions between rests and gaps", () => {
	it("keeps smaller later motions of a property apart from a large first one", () => {
		// 489 -> 175 (314 px), rest, 175 -> 102, rest, 102 -> 175: the later moves are under a quarter of the range.
		const v = (t: number) =>
			489 -
			314 * ramp(t, 400, 200) -
			73 * ramp(t, 1400, 200) +
			73 * ramp(t, 2400, 200);
		const pieces = splitAtRests(series(v, 3200), 0.5);
		expect(pieces).toHaveLength(3);
	});

	it("does not join a swing cut off by a rest to the motion after it", () => {
		// After a gap the element is seen 37 px off its rest, settles, rests 600 ms, then moves 650 px.
		const v = (t: number) =>
			t < 1300 ? 752 - 37 * ramp(t, 1000, 100) : 715 - 650 * ramp(t, 1900, 600);
		const s = series(v, 3000, (t) => t > 300 && t < 1000);
		const pieces = splitAtRests(s, 0.5);
		const last = pieces.at(-1) as Series;
		expect(last[0]?.[1]).toBeCloseTo(715, 0);
		expect(span(last)[0]).toBeGreaterThanOrEqual(1100);
	});

	it("keeps a short move into a gap, where the element left what the tracker sees", () => {
		// 715 -> 810 and gone (95 px of a 680 px range), then later a 680 px move.
		const v = (t: number) =>
			t < 1000 ? 715 + 95 * ramp(t, 400, 150) : 715 - 680 * ramp(t, 2000, 500);
		const s = series(v, 3000, (t) => t > 600 && t < 1500);
		const pieces = splitAtRests(s, 0.5);
		expect(pieces).toHaveLength(2);
		expect(pieces[0]?.at(-1)?.[1]).toBeCloseTo(810, 0);
	});
});

describe("an overshoot that settles", () => {
	it("stays inside its motion when the rest tolerance is wider than the overshoot", () => {
		// A 750 px move out and back sets a 22.5 px rest tolerance; the last move of 290 px overshoots by 26 px.
		const out = (t: number) => 750 * (ramp(t, 400, 300) - ramp(t, 1500, 300));
		const rise = (p: number) => 1.09 * (1 - (1 - p) ** 2);
		const settle = (p: number) => 0.09 * (1 - p * p * (3 - 2 * p));
		const last = (t: number) =>
			t < 3350 ? rise(ramp(t, 3000, 350)) : 1 + settle(ramp(t, 3350, 450));
		const v = (t: number) => 400 + out(t) + 290 * (t < 3000 ? 0 : last(t));
		const pieces = splitAtRests(series(v, 4600), 0.5);
		const move = pieces.at(-1) as Series;
		expect(Math.max(...move.map((p) => p[1]))).toBeCloseTo(716, 0);
		expect(move.at(-1)?.[1]).toBeCloseTo(690, 0);
	});
});
