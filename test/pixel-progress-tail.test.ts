import { describe, expect, it } from "vitest";
import { progressWindows } from "../src/pixel/progress.ts";
import { progressTiming } from "../src/spec/progress-row.ts";

const FRAME_MS = 1000 / 56;
const t = Array.from({ length: 40 }, (_, k) => k * FRAME_MS);

// 40 of 2000 values ink in and out linearly over 90 ms: a change of 5.1 mean levels, about 1 level a frame.
// The fade in starts 4 ms before frame 6 and the fade out ends 4 ms after frame 30, so those frames move it 0.2 levels.
const IN_MS = 6 * FRAME_MS - 4;
const OUT_MS = 30 * FRAME_MS + 4 - 90;
const ink = (ms: number) =>
	Math.round(
		255 *
			Math.min(
				Math.max(0, Math.min(1, (ms - IN_MS) / 90)),
				Math.max(0, Math.min(1, 1 - (ms - OUT_MS) / 90)),
			),
	);
const frames = t.map((ms) =>
	Uint8Array.from({ length: 2000 }, (_, i) => (i < 40 ? ink(ms) : 128)),
);

describe("a short fade whose first or last frame moves it under the rest limit", () => {
	const windows = progressWindows(frames, t, FRAME_MS);

	it("keeps that frame inside the change, bracketed by the true rest frames", () => {
		expect(
			windows.map((w) => [w.fromFrame, w.toFrame, Math.round(w.distance)]),
		).toEqual([
			[5, 11, 5],
			[25, 31, 5],
		]);
	});

	it("fits both fades as 90 ms linear", () => {
		const [fadeIn, fadeOut] = windows.map((w) => progressTiming(w.series));
		expect(Math.abs((fadeIn?.startMs ?? 0) - IN_MS)).toBeLessThan(FRAME_MS);
		expect(Math.abs((fadeOut?.startMs ?? 0) - OUT_MS)).toBeLessThan(FRAME_MS);
		for (const f of [fadeIn, fadeOut]) {
			expect(Math.abs((f?.durationMs ?? 0) - 90)).toBeLessThan(FRAME_MS);
			expect(f?.easing).toEqual({ type: "linear" });
		}
	});
});
