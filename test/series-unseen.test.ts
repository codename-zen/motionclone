import { describe, expect, it } from "vitest";
import type { TrackFrame } from "../src/capture/types.ts";
import { extractSeries } from "../src/measure/series.ts";

const el = (blur: number, seen: boolean) => ({
	index: 0,
	x: 0,
	y: 0,
	w: 10,
	h: 10,
	opacity: seen ? 1 : 0,
	transform: "none",
	filter: blur > 0 ? `blur(${blur}px)` : "none",
	clipPath: "none",
	color: "",
	backgroundColor: "",
	boxShadow: "none",
	quality: seen ? 1 : 0,
	observed: { position: seen, scale: seen, blur: seen, opacity: seen },
});

describe("values a video tracker filled in", () => {
	it("leaves out blur filled in after it was first measured, so a gap holds no motion", () => {
		// Blur 0 is measured, then the element is lost while the filled blur creeps up to 1.4, then seen again at 0.
		const frames: TrackFrame[] = Array.from({ length: 60 }, (_, k) => {
			const lost = k >= 10 && k < 50;
			return {
				frame: k,
				t: k * 17,
				scrollY: 0,
				elements: { a: [el(lost ? (1.4 * (k - 10)) / 40 : 0, !lost)] },
			};
		});
		const s = extractSeries(frames, "a", 0, "blur");
		expect(s).toHaveLength(20);
		expect(Math.max(...s.map((p) => p[1]))).toBe(0);
	});
});
