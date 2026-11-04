import { describe, expect, it } from "vitest";
import { backgroundWindows } from "../src/pixel/background.ts";
import { progressWindows } from "../src/pixel/progress.ts";

const W = 40;
const H = 40;
const FRAME_MS = 20;

/** A W x H region: a flat background, and a white block sliding down from row `top`. */
function frame(bg: number, top: number): Uint8Array {
	const out = new Uint8Array(W * H * 3);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const v = x >= 20 && y >= top ? 255 : bg;
			out.set([v, v, v], (y * W + x) * 3);
		}
	return out;
}

// Background white until frame 10, dark from frame 11, while the block slides from row 0 to row 30 over frames 10-25.
const bgAt = (k: number, fadeFrames: number) =>
	k <= 10
		? 255
		: k >= 10 + fadeFrames
			? 20
			: 255 - ((k - 10) * 235) / fadeFrames;
const topAt = (k: number) =>
	k <= 10 ? 0 : k >= 25 ? 30 : ((k - 10) * 30) / 15;

const clip = (fadeFrames: number) =>
	Array.from({ length: 40 }, (_, k) => frame(bgAt(k, fadeFrames), topAt(k)));
const times = Array.from({ length: 40 }, (_, k) => k * FRAME_MS);

describe("background switches behind moving content", () => {
	it("are not a plain mix of the region's rest frames", () => {
		const [w] = progressWindows(clip(1), times, FRAME_MS);
		expect(w?.blend).toBeGreaterThan(0.05);
	});

	it("read as a one-frame switch from the pixels that flip together", () => {
		const [w, ...rest] = backgroundWindows(clip(1), times, FRAME_MS);
		expect(rest).toEqual([]);
		expect(w).toMatchObject({ fromFrame: 10, toFrame: 11 });
		expect(w?.blend).toBeLessThan(0.01);
	});

	it("read a fade as a fade over its own frames", () => {
		const [w] = backgroundWindows(clip(8), times, FRAME_MS);
		expect(w).toMatchObject({ fromFrame: 10, toFrame: 18 });
		expect(w?.blend).toBeLessThan(0.05);
	});
});
