import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyMotion } from "../src/fit/classify.ts";
import { seriesBounds, timingProblem } from "../src/fit/plausible.ts";
import type { Series } from "../src/measure/series.ts";
import { motionWindow } from "../src/measure/window.ts";
import { draftSpec } from "../src/spec/draft.ts";
import { SpecRow } from "../src/spec/schema.ts";
import { movement, staticMessage } from "../src/verify/messages.ts";
import { FAKE_FRAME_MS as FRAME, fakeTrackCapture } from "./fake-capture.ts";

const FRAMES = 60;
const series = (v: (k: number) => number): Series =>
	Array.from({ length: FRAMES }, (_, k) => [k * FRAME, v(k)]);

// A looping clip cut mid-cycle: a triangle wave, read as a straight line of near-infinite duration.
const loopCut = (k: number) => {
	const u = ((k + 20) % 30) / 30;
	return u < 0.5 ? u * 2 : 2 - u * 2;
};
// A tracker glitch: one lost frame, then a small drift.
const blip = (k: number) => (k === 10 ? 0 : k < 40 ? 1 : 0.98);

describe("fit timing must lie in the clip", () => {
	it("rejects fits that run off the clip, as the loop and glitch series produced", () => {
		for (const s of [series(loopCut), series(blip)]) {
			const w = motionWindow(s);
			if (!w) throw new Error("no window");
			const c = classifyMotion(s, w);
			const bounds = seriesBounds(s, FRAME);
			const inBounds = c.candidates.filter(
				(x) => timingProblem(x.delayMs, x.durationMs, bounds) === null,
			);
			// Before the bound these picked starts near -1e14 ms and durations near 4e14 ms.
			expect(
				c.candidates.some(
					(x) => timingProblem(x.delayMs, x.durationMs, bounds) !== null,
				),
			).toBe(true);
			if (inBounds.length > 0) expect(inBounds).toContain(c.best);
		}
	});

	it("names what is off", () => {
		const b = { firstMs: 0, lastMs: 1000, frameMs: FRAME };
		expect(timingProblem(100, 300, b)).toBeNull();
		expect(timingProblem(-2012022744001.1, 4903811838658, b)).toContain(
			"longer than the clip",
		);
		expect(timingProblem(-582330192651098.6, 400, b)).toContain(
			"outside the clip",
		);
		expect(timingProblem(900, 300, b)).toContain("after the clip");
		expect(timingProblem(100, 0, b)).toContain("not positive");
	});
});

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "motionclone-plausible-"));
	await fakeTrackCapture(dir, FRAMES, (k) => {
		const ease = Math.min(1, Math.max(0, (k * FRAME - 300) / 400));
		return {
			week: { opacity: loopCut(k) },
			sheet: { y: 20 + 30 * blip(k) },
			pulse: { opacity: k === 20 ? 0.2 : 1 },
			card: { x: 20 + 100 * ease },
		};
	});
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("draft drops rows no plausible fit describes", () => {
	it("keeps the real motion and lists the others with their reason", async () => {
		const spec = await draftSpec(dir, { write: false });
		expect(spec.rows.map((r) => r.id)).toEqual(["card[0].x"]);
		const card = spec.rows[0];
		expect(card?.startMs).toBeGreaterThan(250);
		expect(card?.startMs).toBeLessThan(350);
		const reasons = new Map(spec.dropped.map((d) => [d.id, d.reason]));
		expect(reasons.get("week[0].opacity")).toMatch(/no plausible fit/);
		expect(reasons.get("sheet[0].y")).toMatch(/no plausible fit/);
		expect(reasons.get("pulse[0].opacity")).toMatch(/ends where it starts/);
		for (const r of spec.rows) {
			expect(r.durationMs).toBeGreaterThan(0);
			expect(r.durationMs).toBeLessThanOrEqual((FRAMES - 1) * FRAME);
		}
	});
});

describe("messages never ask for a move that ends where it starts", () => {
	const row = (from: number, to: number) =>
		SpecRow.parse({
			id: "pulse[0].opacity",
			selector: "pulse",
			index: 0,
			property: "opacity",
			from,
			to,
			startMs: 100,
			durationMs: 300,
			easing: { type: "linear" },
			overshoot: 0,
			relativeDistance: null,
			source: "measured",
			confidence: "low",
			rmse: 0,
			stagger: null,
		});

	it("words an equal pair as away and back, and adds digits to near pairs", () => {
		const same = staticMessage(row(1, 1), []);
		expect(same).not.toMatch(/1 -> 1/);
		expect(same).toContain("away from 1 and back");
		expect(movement(0.99996, 1)).toBe("0.99996 -> 1");
		expect(movement(0, 24, " px")).toBe("0 px -> 24 px");
	});
});
