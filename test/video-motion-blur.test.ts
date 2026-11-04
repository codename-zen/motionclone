import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Track } from "../src/measure/elements.ts";
import { blurArtefact } from "../src/spec/blur-artefact.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile, SpecRow } from "../src/spec/schema.ts";
import { captureVideo } from "../src/video/index.ts";
import { encodeFrames } from "./video-helpers.ts";

const FPS = 56;
const W = 400;
const H = 720;
const FRAMES = 140;
const CARD = { x: 20, w: 360, h: 140 };
// The card slides down 400 px and back up, easeOutCubic over 260 ms; it never fades.
const SLIDES = [
	{ startMs: 300, from: 80, to: 480 },
	{ startMs: 1500, from: 480, to: 80 },
];
const SLIDE_MS = 260;
const SUBFRAMES = 8;
// The shutter is open for 0.15 of each frame interval (1/373 s), as a phone records a bright screen.
const SHUTTER = 0.15;
const PAGE = 242;

const easeOutCubic = (u: number) => 1 - (1 - u) ** 3;

function topAt(t: number): number {
	let y = SLIDES[0]?.from as number;
	for (const s of SLIDES) {
		if (t < s.startMs) break;
		const u = Math.min(1, (t - s.startMs) / SLIDE_MS);
		y = s.from + (s.to - s.from) * easeOutCubic(u);
	}
	return y;
}

/** The card in grey levels: white, with three rows of dark word-like bars 24 px tall. */
function card(): Float32Array {
	const g = new Float32Array(CARD.w * CARD.h).fill(255);
	for (let row = 0; row < 3; row++) {
		let x = 16;
		for (let k = 0; x < CARD.w - 40; k++) {
			const w = 8 + ((k * 37 + row * 11) % 5) * 7;
			for (let y = 24 + row * 40; y < 48 + row * 40; y++)
				for (let i = x; i < x + w; i++) g[y * CARD.w + i] = 30;
			x += w + 6 + (k % 3 === 2 ? 12 : 0);
		}
	}
	return g;
}

/** One frame: the card's positions averaged over the time the shutter is open. */
function frame(sprite: Float32Array, k: number): PNG {
	const png = new PNG({ width: W, height: H });
	const acc = new Float32Array(W * H).fill(0);
	for (let s = 0; s < SUBFRAMES; s++) {
		const top = topAt(((k + (SHUTTER * s) / SUBFRAMES) * 1000) / FPS);
		for (let y = 0; y < H; y++) {
			const v = y - top;
			const v0 = Math.floor(v);
			const f = v - v0;
			const rowAt = (r: number, i: number) =>
				r >= 0 && r < CARD.h ? (sprite[r * CARD.w + i] as number) : PAGE;
			for (let x = 0; x < W; x++) {
				const i = x - CARD.x;
				const g =
					i < 0 || i >= CARD.w
						? PAGE
						: (1 - f) * rowAt(v0, i) + f * rowAt(v0 + 1, i);
				acc[y * W + x] = (acc[y * W + x] as number) + g / SUBFRAMES;
			}
		}
	}
	for (let p = 0; p < W * H; p++) {
		const g = Math.round(acc[p] as number);
		png.data[p * 4] = g;
		png.data[p * 4 + 1] = g;
		png.data[p * 4 + 2] = g;
		png.data[p * 4 + 3] = 255;
	}
	return png;
}

describe("video input: a card that slides with motion blur and never fades", () => {
	let tmp: string;
	let spec: SpecFile;

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone motion-blur-"));
		const src = join(tmp, "src");
		await mkdir(join(src, "frames"), { recursive: true });
		const sprite = card();
		for (let k = 0; k < FRAMES; k++)
			await writeFile(
				join(src, "frames", `${String(k).padStart(4, "0")}.png`),
				PNG.sync.write(frame(sprite, k)),
			);
		const mp4 = join(tmp, "blur.mp4");
		await encodeFrames(src, mp4, FPS, [
			"-c:v",
			"libx264",
			"-crf",
			"23",
			"-pix_fmt",
			"yuv420p",
		]);
		const summary = await captureVideo({
			input: mp4,
			outDir: join(tmp, "ref"),
			regions: [{ name: "card", x: 0, y: 60, w: W, h: 600 }],
		});
		spec = await draftSpec(summary.outDir, { write: false });
	}, 300_000);

	afterAll(async () => {
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	it("drafts both slides and no opacity row", () => {
		expect(spec.rows.filter((r) => r.property === "y")).toHaveLength(2);
		expect(spec.rows.filter((r) => r.property === "opacity")).toEqual([]);
	});

	it("drops the blur-dimmed readings at the end of a slide with a note", () => {
		const blur = spec.dropped.filter((d) => /motion blur/.test(d.reason));
		expect(blur.length).toBeGreaterThan(0);
		for (const d of blur) {
			expect(d.property).toBe("opacity");
			expect(d.reason).toMatch(/card\[0\]\.y(#2)? comes to rest/);
		}
	});
});

describe("blur artefacts are told from fades", () => {
	const frameMs = 1000 / FPS;
	const row = (p: Partial<SpecRow>): SpecRow =>
		({
			selector: "card",
			index: 0,
			source: "measured",
			...p,
		}) as SpecRow;
	const slide = row({
		id: "card[0].y",
		property: "y",
		startMs: 0,
		durationMs: 200,
	});
	const fade = row({
		id: "card[0].opacity",
		property: "opacity",
		from: 0.9,
		to: 1,
		startMs: 160,
		durationMs: 60,
	});
	/** A track whose box moves `speed` px a frame and reads opacity 0.9 on frames 9 to 11. */
	const track = (speed: number): Track => ({
		selectors: ["card"],
		frameMs,
		frames: Array.from({ length: 20 }, (_, k) => ({
			frame: k,
			t: k * frameMs,
			scrollY: 0,
			elements: {
				card: [
					{
						index: 0,
						x: 0,
						y: speed * k,
						w: 100,
						h: 50,
						opacity: k >= 9 && k <= 11 ? 0.9 : 1,
						transform: "none",
						filter: "none",
						clipPath: "none",
						color: "",
						backgroundColor: "",
						boxShadow: "none",
					},
				],
			},
		})),
	});

	it("drops a small rise while the box still moves at the end of its slide", () => {
		expect(blurArtefact(fade, [slide, fade], track(3), frameMs)).toMatch(
			/^motion blur, not a fade/,
		);
	});

	it("keeps a fade while the box stands still, a larger fade and a fade with no slide", () => {
		expect(blurArtefact(fade, [slide, fade], track(0), frameMs)).toBeNull();
		const big = { ...fade, from: 0.7 };
		expect(blurArtefact(big, [slide, big], track(3), frameMs)).toBeNull();
		expect(blurArtefact(fade, [fade], track(3), frameMs)).toBeNull();
	});
});
