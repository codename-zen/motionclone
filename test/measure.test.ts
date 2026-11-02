import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import type { TrackedElement, TrackFrame } from "../src/capture/types.ts";
import {
	listMovingElements,
	movingProperties,
} from "../src/measure/elements.ts";
import {
	decompose,
	extractSeries,
	readProperty,
	valueAt,
} from "../src/measure/series.ts";
import { blurPx } from "../src/measure/style.ts";
import { motionWindow } from "../src/measure/window.ts";
import { motionProperties } from "../src/spec/motion.ts";
import { type StaticServer, serveRepo } from "./serve.ts";
import { bezierCurve, FRAME_MS, sample, springCurve } from "./synth.ts";

describe("decompose", () => {
	it("reads a 2D matrix", () => {
		const a = (30 * Math.PI) / 180;
		const m = `matrix(${2 * Math.cos(a)}, ${2 * Math.sin(a)}, ${-3 * Math.sin(a)}, ${3 * Math.cos(a)}, 10, -5)`;
		const d = decompose(m);
		expect(d.translateX).toBeCloseTo(10);
		expect(d.translateY).toBeCloseTo(-5);
		expect(d.scaleX).toBeCloseTo(2);
		expect(d.scaleY).toBeCloseTo(3);
		expect(d.rotate).toBeCloseTo(30);
		expect(d.scale).toBeCloseTo(Math.sqrt(6));
	});

	it("reads matrix3d and none", () => {
		expect(
			decompose("matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 12,34,0,1)"),
		).toMatchObject({ translateX: 12, translateY: 34, scaleX: 1, rotate: 0 });
		expect(decompose("none")).toMatchObject({ translateX: 0, scale: 1 });
	});
});

describe("blur and individual transforms", () => {
	const el = (over: Partial<TrackedElement>): TrackedElement => ({
		index: 0,
		x: 0,
		y: 0,
		w: 200,
		h: 100,
		opacity: 1,
		transform: "none",
		filter: "none",
		clipPath: "none",
		color: "",
		backgroundColor: "",
		boxShadow: "",
		...over,
	});

	it("reads blur radii from a computed filter", () => {
		expect(blurPx("none")).toBe(0);
		expect(blurPx("blur(12px)")).toBe(12);
		expect(blurPx("blur(3px) brightness(1.2)")).toBe(3);
		expect(blurPx("blur(3px) blur(4px)")).toBeCloseTo(5);
		expect(readProperty(el({ filter: "blur(0px)" }), "blur")).toBe(0);
	});

	it("applies translate, rotate and scale before transform", () => {
		const e = el({ scale: "0.5", transform: "matrix(1, 0, 0, 1, 10, 0)" });
		expect(readProperty(e, "scale")).toBeCloseTo(0.5);
		expect(readProperty(e, "translateX")).toBeCloseTo(5);
		const t = el({ translate: "50% 8px", rotate: "90deg" });
		expect(readProperty(t, "translateX")).toBeCloseTo(100);
		expect(readProperty(t, "translateY")).toBeCloseTo(8);
		expect(readProperty(t, "rotate")).toBeCloseTo(90);
		expect(readProperty(el({ scale: "2 3" }), "scaleY")).toBeCloseTo(3);
		expect(readProperty(el({ rotate: "x 40deg" }), "rotate")).toBe(0);
	});

	it("finds scale and blur from matrix and filter strings alone, as video tracks write them", () => {
		const frames: TrackFrame[] = Array.from({ length: 30 }, (_, k) => {
			const t = Math.round(k * FRAME_MS);
			const p = Math.min(1, Math.max(0, (t - 100) / 300));
			const s = 0.9 + 0.1 * p;
			return {
				frame: k,
				t,
				scrollY: 0,
				elements: {
					card: [
						el({
							transform: `matrix(${s}, 0, 0, ${s}, 0, 0)`,
							filter: `blur(${10 * (1 - p)}px)`,
						}),
					],
				},
			};
		});
		const out = movingProperties({
			selectors: ["card"],
			frameMs: FRAME_MS,
			frames,
		});
		const blur = out.find((m) => m.property === "blur");
		const scale = out.find((m) => m.property === "scale");
		expect(blur?.window).toMatchObject({ from: 10, to: 0, relative: null });
		expect(scale?.window.from).toBeCloseTo(0.9);
		expect(scale?.window.to).toBeCloseTo(1);
		// The box does not travel, so scale explains its size change and no x/y/width rows remain.
		expect(
			motionProperties({ selectors: ["card"], frameMs: FRAME_MS, frames })
				.map((m) => m.property)
				.sort(),
		).toEqual(["blur", "scale"]);
	});

	it("keeps box travel that a scale change cannot explain", () => {
		const frames: TrackFrame[] = Array.from({ length: 30 }, (_, k) => {
			const t = Math.round(k * FRAME_MS);
			const p = Math.min(1, Math.max(0, (t - 100) / 300));
			const s = 0.98 + 0.02 * p;
			return {
				frame: k,
				t,
				scrollY: 0,
				elements: {
					card: [
						el({
							y: 40 * (1 - p),
							transform: `matrix(${s}, 0, 0, ${s}, 0, 0)`,
						}),
					],
				},
			};
		});
		const props = motionProperties({
			selectors: ["card"],
			frameMs: FRAME_MS,
			frames,
		}).map((m) => m.property);
		expect(props.sort()).toEqual(["scale", "y"]);
	});
});

describe("valueAt", () => {
	it("interpolates and clamps", () => {
		const s: [number, number][] = [
			[0, 0],
			[100, 10],
			[200, 10],
		];
		expect(valueAt(s, 50)).toBe(5);
		expect(valueAt(s, -5)).toBe(0);
		expect(valueAt(s, 500)).toBe(10);
	});
});

describe("motionWindow", () => {
	it("measures a bezier move", () => {
		const s = sample(bezierCurve([0.4, 0, 0.2, 1], 200, 500), { to: 40 });
		const w = motionWindow(s, { size: 80 });
		if (!w) throw new Error("no window");
		expect(w.from).toBe(0);
		expect(w.to).toBeCloseTo(40);
		expect(w.thereAndBack).toBe(false);
		expect(w.overshoot).toBe(0);
		expect(w.relative).toBeCloseTo(0.5);
		expect(w.startMs).toBeGreaterThanOrEqual(200);
		expect(w.startMs).toBeLessThanOrEqual(200 + 2 * FRAME_MS);
		expect(w.endMs).toBeGreaterThan(600);
		expect(w.endMs).toBeLessThanOrEqual(700 + FRAME_MS);
	});

	it("reports spring overshoot", () => {
		const s = sample(springCurve({ stiffness: 300, damping: 20, mass: 1 }, 0), {
			lengthMs: 2000,
		});
		const w = motionWindow(s);
		expect(w?.overshoot).toBeGreaterThan(0.1);
		expect(w?.overshoot).toBeLessThan(0.11);
	});

	it("flags there-and-back motion", () => {
		const s = sample(
			(t) =>
				Math.sin((Math.PI * Math.max(0, t - 100)) / 600) ** 2 *
				(t < 700 ? 1 : 0),
		);
		const w = motionWindow(s);
		expect(w?.thereAndBack).toBe(true);
		expect(w?.peak).toBeCloseTo(100, 0);
		expect(w?.peakMs).toBeGreaterThan(350);
		expect(w?.peakMs).toBeLessThan(450);
	});

	it("returns null without movement", () => {
		expect(motionWindow(sample(() => 0))).toBeNull();
	});
});

describe("movingProperties", () => {
	const frames: TrackFrame[] = Array.from({ length: 40 }, (_, k) => {
		const t = Math.round(k * FRAME_MS);
		const p = Math.min(1, Math.max(0, (t - 100) / 300));
		const el = (index: number, moves: boolean) => ({
			index,
			x: 10,
			y: 20,
			w: 100,
			h: 50,
			opacity: moves ? p : 1,
			transform: moves ? `matrix(1, 0, 0, 1, ${50 * p}, 0)` : "none",
			filter: "none",
			clipPath: "none",
			color: "",
			backgroundColor: "",
			boxShadow: "",
		});
		return {
			frame: k,
			t,
			scrollY: 0,
			elements: { ".a": [el(0, true), el(1, false)] },
		};
	});

	it("lists only properties that move, with windows and relative distance", () => {
		const out = movingProperties({
			selectors: [".a"],
			frameMs: FRAME_MS,
			frames,
		});
		expect(out.map((o) => `${o.index}:${o.property}`).sort()).toEqual([
			"0:opacity",
			"0:translateX",
		]);
		const tx = out.find((o) => o.property === "translateX");
		expect(tx?.window.relative).toBeCloseTo(0.5);
		expect(extractSeries(frames, ".a", 0, "translateX")).toHaveLength(40);
	});
});

describe("elements on a real capture", () => {
	let server: StaticServer;
	let root: string;
	beforeAll(async () => {
		server = await serveRepo();
		root = await mkdtemp(join(tmpdir(), "motionclone-measure-"));
	});
	afterAll(async () => {
		await server?.close();
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("css-fade-up-stagger windows follow the stagger", async () => {
		const summary = await captureMotion({
			url: `${server.url}/fixtures/css-fade-up-stagger/index.html`,
			outDir: join(root, "fade"),
			durationMs: 1300,
			fps: 60,
			track: [".card"],
		});
		const moving = await listMovingElements(summary.outDir);
		const ty = moving.filter((m) => m.property === "translateY");
		expect(ty.map((m) => m.index)).toEqual([0, 1, 2, 3]);
		for (const m of ty) {
			const delay = 200 + 90 * m.index;
			expect(m.window.from).toBeCloseTo(32);
			expect(m.window.to).toBeCloseTo(0);
			expect(m.window.startMs - delay).toBeGreaterThanOrEqual(0);
			expect(m.window.startMs - delay).toBeLessThanOrEqual(2 * FRAME_MS);
			expect(m.window.relative).toBeCloseTo(32 / 160);
		}
		expect(moving.filter((m) => m.property === "opacity")).toHaveLength(4);
	});
});
