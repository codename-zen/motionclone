import { describe, expect, it } from "vitest";
import type { TrackedElement } from "../src/capture/types.ts";
import { bezierY } from "../src/fit/bezier.ts";
import { fitJoint } from "../src/fit/joint.ts";
import type { Track } from "../src/measure/elements.ts";
import type { CaptureFile } from "../src/spec/capture-file.ts";
import { observationModel, observe } from "../src/spec/observe.ts";

const EASE = [0.22, 1, 0.36, 1] as const;
const FRAME_MS = 1000 / 60;

/** One card fading in, growing from 0.92 and unblurring from 12 px over 600 ms from 150 ms, as a video would report it. */
function videoTrack(): Track {
	const frames = Array.from({ length: 60 }, (_, k) => {
		const t = Math.round(k * FRAME_MS);
		const p = bezierY(EASE, (t - 150) / 600);
		// As measured on h264: the faintest frames read 0, faint ones read low, near-opaque snaps to 1.
		const opacity =
			p < 0.15
				? 0
				: p >= 0.98
					? 1
					: Number((p < 0.3 ? p - 0.08 : p).toFixed(2));
		const shown = opacity >= 0.2 ? p : 0.4;
		const scale = 0.92 + 0.08 * shown;
		const blur = 12 * (1 - shown);
		const el: TrackedElement = {
			index: 0,
			x: 0,
			y: 0,
			w: 100,
			h: 100,
			opacity,
			transform: `matrix(${scale}, 0, 0, ${scale}, 0, 0)`,
			filter: blur < 1 ? "none" : `blur(${blur}px)`,
			clipPath: "none",
			color: "",
			backgroundColor: "",
			boxShadow: "none",
		};
		return { frame: k, t, scrollY: 0, elements: { card: [el] } };
	});
	return { selectors: ["card"], frameMs: FRAME_MS, frames };
}

const VIDEO = {
	source: "video",
	video: { scale: 1, cssScale: 1 },
} as unknown as CaptureFile;

describe("partly observed motion", () => {
	it("reads faint, snapped and filled video frames as bounds or nothing", () => {
		const track = videoTrack();
		const model = observationModel(VIDEO);
		const opacity = observe(track, "card", 0, "opacity", model);
		expect(opacity.fromObserved).toBe(false);
		expect(opacity.boundedStart).toBe(true);
		expect(opacity.obs[0]).toEqual({ t: 0, lo: 0, hi: 0.15 });
		expect(opacity.obs.at(-1)).toMatchObject({ lo: 0.95, hi: 1 });
		const scale = observe(track, "card", 0, "scale", model);
		expect(scale.fromObserved).toBe(false);
		expect(scale.boundedStart).toBe(false);
		expect(scale.obs[0]?.t).toBeGreaterThan(150);
		const page = observe(
			track,
			"card",
			0,
			"scale",
			observationModel({} as CaptureFile),
		);
		expect(page.fromObserved).toBe(true);
		expect(page.obs).toHaveLength(track.frames.length);
	});

	it("recovers timing, easing and unseen start values when the bounded track leads", () => {
		const track = videoTrack();
		const model = observationModel(VIDEO);
		const props = ["opacity", "scale", "blur"] as const;
		const tracks = props.map((p) => {
			const o = observe(track, "card", 0, p, model);
			return {
				obs: o.obs,
				to: { opacity: 1, scale: 1, blur: 0 }[p],
				weight: o.boundedStart ? 1 : 0,
				group: 0,
			};
		});
		const fit = fitJoint(
			tracks,
			[{ startMs: 183, endMs: 450, frameMs: FRAME_MS }],
			0,
		);
		expect(fit.p).toEqual(EASE);
		expect(Math.abs((fit.delays[0] as number) - 150)).toBeLessThan(1);
		expect(Math.abs(fit.durationMs - 600)).toBeLessThan(5);
		expect(Math.abs((fit.froms[1] as number) - 0.92)).toBeLessThan(0.002);
		expect(Math.abs((fit.froms[2] as number) - 12)).toBeLessThan(0.2);
	});
});
