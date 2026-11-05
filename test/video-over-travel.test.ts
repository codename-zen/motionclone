import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleBox } from "../src/video/samples.ts";
import { scanClip } from "../src/video/scan.ts";
import { trackRegions } from "../src/video/track.ts";
import { grain, writeFrames } from "./synth-frames.ts";

const W = 240;
const H = 420;
const FRAMES = 60;
// A dark strip with light marks rests at y 100, slides to y 300 over frames 20-39 and rests there. The card above it
// grows down with it over striped content, and the card below rides on it while its content cross-fades, so most of
// the region changes between the clip ends while only the strip travels rigidly.
const stripY = (k: number) =>
	k < 20 ? 100 : k >= 40 ? 300 : 100 + ((k - 20) / 20) * 200;
const STRIP_H = 44;

function draw(k: number, x: number, y: number): number {
	const top = stripY(k);
	if (y >= top && y < top + STRIP_H) {
		const u = x - 20;
		const v = y - top;
		const mark =
			u >= 0 &&
			u < 200 &&
			v > 10 &&
			v < 34 &&
			grain(Math.floor(u / 9), 1) > 0.5;
		return mark ? 220 : 30;
	}
	if (y < top && y >= 40) return y % 16 < 6 && x % 50 < 40 ? 70 : 225;
	const below = y - top - STRIP_H;
	if (below >= 0 && below < 80) {
		const mix = Math.min(1, Math.max(0, (k - 20) / 20));
		const a = (Math.floor(x / 20) + Math.floor(below / 10)) % 2 ? 80 : 200;
		const b = (Math.floor(x / 13) + Math.floor(below / 7)) % 3 ? 220 : 60;
		return a + (b - a) * mix;
	}
	return 235 + 15 * grain(x, y);
}

describe("a region drawn over the whole travel of a strip", () => {
	let dir: string;
	beforeAll(async () => {
		dir = await writeFrames("over-travel", W, H, FRAMES, draw);
	});
	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("follows the strip from rest to rest", async () => {
		const scan = await scanClip(dir, FRAMES);
		const [t] = await trackRegions(
			dir,
			scan,
			[{ name: "strip", x: 0, y: 60, w: W, h: 320, ref: "auto" }],
			3,
			[],
		);
		const found = t?.samples.filter((s) => s.found).length ?? 0;
		expect(found).toBeGreaterThan(0.9 * FRAMES);
		const top = (k: number) => {
			const s = t?.samples[k];
			return s && t ? sampleBox(t.box, s).y : Number.NaN;
		};
		// The box follows the strip's top within 2 px, wherever it is.
		const offset = top(0) - stripY(0);
		for (const k of [0, 19, 25, 33, 45, 59])
			expect(Math.abs(top(k) - stripY(k) - offset)).toBeLessThan(2);
		expect(t?.box.h).toBeLessThan(STRIP_H + 16);
	});
});
