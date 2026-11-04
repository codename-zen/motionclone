import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrackedElement } from "../src/capture/types.ts";
import { bezierY, fitTiming } from "../src/fit/bezier.ts";
import { classifyMotion, normaliseIn } from "../src/fit/classify.ts";
import { seriesBounds, timingProblem } from "../src/fit/plausible.ts";
import type { Track } from "../src/measure/elements.ts";
import type { Series } from "../src/measure/series.ts";
import { motionWindow } from "../src/measure/window.ts";
import { readVerdictLabel } from "../src/media/verdict-label.ts";
import { draftSpec } from "../src/spec/draft.ts";
import { bezierEasing } from "../src/spec/easing.ts";
import { SpecRow } from "../src/spec/schema.ts";
import { indexClone, measureClone } from "../src/verify/clone.ts";
import { ms, timingMessage } from "../src/verify/messages.ts";
import { checkedCounts, countsByKind } from "../src/verify/schema.ts";
import { element, FAKE_FRAME_MS, fakeTrackCapture } from "./fake-capture.ts";

const OUT_QUINT = [0.22, 1, 0.36, 1] as const;
const FRAMES = 252;

/** 0 to 1 along easeOutQuint from `start` over `duration` ms. */
const ease = (t: number, start: number, duration: number) =>
	bezierY([...OUT_QUINT], (t - start) / duration);

// A sheet that slides down and back up twice, as a looping rebuild does; the spec saw only the first slide.
const sheetY = (t: number) =>
	163 +
	440 *
		(ease(t, 600, 330) -
			ease(t, 2600, 330) +
			ease(t, 4800, 330) -
			ease(t, 7000, 330));

const row = SpecRow.parse({
	id: "sheet[0].y",
	selector: "sheet",
	index: 0,
	property: "y",
	from: 163,
	to: 603,
	startMs: 600,
	durationMs: 330,
	easing: bezierEasing([...OUT_QUINT]),
	overshoot: 0,
	relativeDistance: null,
	source: "measured",
	confidence: "low",
	rmse: 0,
	stagger: null,
});

describe("a clone that moves a property more often than the spec row it is checked against", () => {
	const track: Track = {
		selectors: ["sheet"],
		frameMs: FAKE_FRAME_MS,
		frames: Array.from({ length: FRAMES }, (_, k) => ({
			frame: k,
			t: k * FAKE_FRAME_MS,
			scrollY: 0,
			elements: { sheet: [element({ y: sheetY(k * FAKE_FRAME_MS) })] },
		})),
	};

	it("pairs the row with the clone motion nearest it in time, fitted inside the clip", () => {
		const c = measureClone(indexClone(track), row, 1);
		if (c.status !== "moving") throw new Error(c.status);
		expect(Math.abs(c.startMs - 600)).toBeLessThan(FAKE_FRAME_MS);
		expect(Math.abs(c.durationMs - 330)).toBeLessThan(0.1 * 330);
		expect(c.motion.window.change).toBeCloseTo(440, 0);
	});

	it("never prints an astronomical time", () => {
		expect(ms(-546404056958217)).toBe("under -1000000");
		expect(ms(Number.NaN)).toBe("over 1000000");
		expect(ms(599.4)).toBe("599");
		const text = timingMessage(row, "start", {
			want: 599,
			got: -546404056958217,
			diff: -546404056958816,
			tol: 50,
			unit: "ms",
			pass: false,
		});
		expect(text).not.toMatch(/\d{8}/);
		expect(text).toContain("starts over 1000000 ms early");
	});
});

describe("bounded timing fits", () => {
	it("keeps a plateau read as a curve inside the clip", () => {
		const samples = Array.from(
			{ length: 60 },
			(_, k) => [k * FAKE_FRAME_MS, k < 3 ? 0.98 : 1] as const,
		);
		const hint = {
			startMs: 0,
			endMs: 100,
			frameMs: FAKE_FRAME_MS,
			clip: { firstMs: 0, lastMs: 59 * FAKE_FRAME_MS },
		};
		const t = fitTiming(samples, hint, (u) => u);
		const bounds = seriesBounds(
			samples.map(([s, v]): [number, number] => [s, v]),
			FAKE_FRAME_MS,
		);
		expect(timingProblem(t.delayMs, t.durationMs, bounds)).toBeNull();
	});

	it("drafts a plausible curve for a clean motion, every candidate within reach", () => {
		const s: Series = Array.from({ length: 60 }, (_, k) => [
			k * FAKE_FRAME_MS,
			20 + 30 * ease(k * FAKE_FRAME_MS, 500, 400),
		]);
		const c = classifyMotion(
			s,
			motionWindow(s) as NonNullable<ReturnType<typeof motionWindow>>,
		);
		expect(Math.abs(c.best.delayMs - 500)).toBeLessThan(FAKE_FRAME_MS);
		for (const x of c.candidates.filter((x) => x.kind !== "spring"))
			expect(Math.abs(x.delayMs)).toBeLessThan(1e5);
	});
});

// A video track of text that the tracker loses while a sheet covers it, then sees again moving down.
const LOST = { position: false, scale: false, blur: false, opacity: false };
const SEEN = { position: true, scale: true, blur: true, opacity: true };
const revealed = (t: number) =>
	40 + 20 * (ease(t, 600, 300) + ease(t, 4800, 300)) - 20 * ease(t, 2600, 1);

function summaryAt(k: number): Partial<TrackedElement> {
	const t = k * FAKE_FRAME_MS;
	const hidden = t >= 2600 && t < 4800;
	if (!hidden) return { y: revealed(t), quality: 1, observed: SEEN };
	// The tracker interpolates the lost box from the last seen to the next seen place.
	const u = (t - 2600) / 2200;
	return { y: 60 + (revealed(4800) - 60) * u, quality: 0, observed: LOST };
}

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "motionclone-clone-fits-"));
	await fakeTrackCapture(dir, FRAMES, (k) => ({ summary: summaryAt(k) }), {
		source: "video",
		video: { scale: 1, cssScale: 1 },
	});
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("a motion seen again after the tracker lost the element", () => {
	it("drafts one row per seen motion; the interpolated drift is no motion", async () => {
		const spec = await draftSpec(dir, { write: false });
		const ys = spec.rows.filter((r) => r.property === "y");
		expect(ys.map((r) => r.id)).toEqual(["summary[0].y", "summary[0].y#2"]);
		const [first, second] = ys as [SpecRow, SpecRow];
		expect(Math.abs(first.startMs - 600)).toBeLessThan(3 * FAKE_FRAME_MS);
		expect(Math.abs(second.startMs - 4800)).toBeLessThan(3 * FAKE_FRAME_MS);
		for (const r of ys) {
			expect(r.durationMs).toBeGreaterThan(150);
			expect(r.durationMs).toBeLessThan(600);
			expect(r.to - r.from).toBeGreaterThan(15);
		}
		expect(spec.dropped.filter((d) => d.property === "y")).toEqual([]);
	});
});

describe("verdict counts", () => {
	const verdict = {
		pass: false,
		summary: { rows: 6, passed: 4, failed: 0, advisory: 2 },
		look: { summary: { rows: 13, passed: 12, failed: 1 } },
	};

	it("count motion and look rows, split by kind", () => {
		expect(checkedCounts(verdict)).toMatchObject({ passed: 16, checked: 17 });
		expect(countsByKind(verdict)).toBe("motion 4/4, look 12/13");
		expect(countsByKind({ ...verdict, look: null })).toBe("");
	});

	it("label a side by side with every checked row", async () => {
		await writeFile(join(dir, "verdict.json"), JSON.stringify(verdict));
		expect((await readVerdictLabel(dir))?.text).toBe("FAIL 16/17");
	});
});

describe("a recording that repeats frames", () => {
	// Content at 28 fps encoded at 56 fps: every reading is shown twice, at its own time and one frame later.
	const frame = 1000 / 56;
	const s: Series = Array.from({ length: 80 }, (_, k) => {
		const shown = k - (k % 2);
		return [k * frame, 163 + 440 * ease(shown * frame, 300, 330)];
	});

	it("fits the curve to the first time of each repeated reading", () => {
		const w = motionWindow(s) as NonNullable<ReturnType<typeof motionWindow>>;
		const { samples } = normaliseIn(s, w);
		const mid = samples.filter(([, p]) => p > 0.002 && p < 0.998);
		expect(new Set(mid.map(([, p]) => p)).size).toBe(mid.length);
		const c = classifyMotion(s, w);
		expect(Math.abs(c.best.delayMs - 300)).toBeLessThan(frame);
		expect(Math.abs(c.best.durationMs - 330) / 330).toBeLessThan(0.1);
	});
});
