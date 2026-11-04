import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { captureLines } from "../src/cli/capture-run.ts";
import { probeLines } from "../src/cli/video-args.ts";
import { fitCropToScale } from "../src/video/crop-fit.ts";
import { guessCssScale } from "../src/video/css-scale.ts";
import { probeVideo } from "../src/video/probe.ts";
import { probeScreen } from "../src/video/screen-probe.ts";
import { encodeFrames, frameFile, readPng, X264 } from "./video-helpers.ts";

const FPS = 30;
// A 390x600 CSS px phone screen shown at 1.5x: 585x900 video pixels at 300,60, inside a black bezel and a grey frame.
const SCREEN = { x: 300, y: 60, w: 585, h: 900 };
const APP = `
  <div style="position:absolute;left:24px;top:20px;font:600 15px sans-serif;color:#111">9:41</div>
  <div style="position:absolute;left:0;top:52px;width:390px;height:44px;background:#eef0f4"></div>
  <div class="card" style="position:absolute;left:24px;top:120px;width:120px;height:120px;background:#3b6ff5;animation:slide 400ms linear 300ms forwards"></div>
  <div class="panel" style="position:absolute;left:0;top:600px;width:390px;height:300px;background:#262a33;animation:rise 300ms linear 1200ms forwards"></div>`;
const STYLE = `<style>
  body { margin: 0; overflow: hidden; }
  @keyframes slide { to { transform: translateX(200px); } }
  @keyframes rise { to { transform: translateY(-260px); } }
</style>`;
const PHONE = `<!doctype html><html><head>${STYLE}</head>
<body style="width:1000px;height:1000px;background:#b8473a">
  <div style="position:absolute;left:276px;top:36px;width:633px;height:948px;border-radius:84px;background:#c8c8cc"></div>
  <div style="position:absolute;left:282px;top:42px;width:621px;height:936px;border-radius:78px;background:#050505"></div>
  <div style="position:absolute;left:300px;top:60px;width:390px;height:600px;transform:scale(1.5);transform-origin:0 0;border-radius:40px;overflow:hidden;background:#fff">${APP}</div>
</body></html>`;
const CLONE = `<!doctype html><html><head>${STYLE}</head><body style="width:390px;height:600px;background:#fff">${APP}</body></html>`;

interface Tracked {
	frames: { elements: Record<string, { x: number; y: number }[]> }[];
}

/** The frames a tracked element moves on: the still frame before its first move and the frame its last move lands on. */
function moveSpan(track: Tracked, selector: string): [number, number] {
	const pos = track.frames.map((f) => f.elements[selector]?.[0]);
	const moved = pos
		.map((p, k) => k > 0 && (p?.x !== pos[k - 1]?.x || p?.y !== pos[k - 1]?.y))
		.flatMap((m, k) => (m ? [k] : []));
	return [(moved[0] as number) - 1, moved.at(-1) as number];
}

describe("probe --screen on a phone recording", () => {
	let tmp: string;
	let mp4: string;
	let track: Tracked;
	const dir = (n: string) => join(tmp, n);

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-screen-"));
		await mkdir(dir("pages"));
		await writeFile(dir("pages/phone.html"), PHONE);
		await writeFile(dir("pages/clone.html"), CLONE);
		const s = await captureMotion({
			url: dir("pages/phone.html"),
			outDir: dir("dom"),
			durationMs: 2000,
			fps: FPS,
			viewport: { width: 1000, height: 1000 },
			track: [".card", ".panel"],
		});
		track = JSON.parse(await readFile(join(s.outDir, "track.json"), "utf8"));
		mp4 = dir("rec.mp4");
		await encodeFrames(s.outDir, mp4, FPS, X264);
	}, 240_000);

	afterAll(async () => {
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	it("finds the screen within 4 px and suggests css-scale 1.5", async () => {
		const p = await probeScreen(mp4, await probeVideo(mp4));
		const r = p.screen?.rect;
		expect(p.screen?.confident).toBe(true);
		for (const k of ["x", "y", "w", "h"] as const)
			expect(Math.abs((r?.[k] ?? -99) - SCREEN[k])).toBeLessThanOrEqual(4);
		expect(p.scale).toMatchObject({ cssScale: 1.5, cssWidth: 390 });
		expect((p.crop?.w ?? 0) / 1.5).toBe(Math.round((p.crop?.w ?? 0) / 1.5));
		expect((p.crop?.h ?? 0) / 1.5).toBe(Math.round((p.crop?.h ?? 0) / 1.5));
	});

	it("finds the motion windows within 2 frames of the transitions", async () => {
		const p = await probeScreen(mp4, await probeVideo(mp4));
		const want = [moveSpan(track, ".card"), moveSpan(track, ".panel")];
		expect(p.windows).toHaveLength(2);
		for (const [i, [from, to]] of want.entries()) {
			const w = p.windows[i];
			expect(Math.abs((w?.fromFrame ?? -99) - from)).toBeLessThanOrEqual(2);
			expect(Math.abs((w?.toFrame ?? -99) - to)).toBeLessThanOrEqual(2);
		}
	});

	it("prints the screen, the suggested flags and a contact sheet", async () => {
		const lines = await probeLines(mp4, { sheet: dir("sheet"), every: 250 });
		const text = lines.join("\n");
		expect(text).toMatch(/^screen: 58\dx(89\d|90\d) at /m);
		expect(text).toContain("--css-scale 1.5");
		expect(text).toMatch(/^motion on the screen: .+ s, .+ s \(/m);
		const sheet = await readPng(join(dir("sheet"), "contact-sheet.png"));
		expect(text).toContain("contact sheet:");
		expect(text).toMatch(/\(\d+ frames, every 250 ms, cropped to the screen\)/);
		expect(sheet.width).toBeGreaterThan(1000);
	});

	it("trims an odd crop to whole CSS pixels with a warning, and --like matches its frame size", async () => {
		const lines = await captureLines({
			url: mp4,
			out: dir("ref"),
			crop: "299,60,586,899",
			cssScale: 1.5,
			regions: ["card=36,180,180,180"],
		});
		expect(lines.join("\n")).toContain(
			"trimmed to 299,60,585,897 (390x598 CSS px)",
		);
		const ref = await readPng(frameFile(dir("ref"), 0));
		expect([ref.width, ref.height]).toEqual([585, 897]);
		// The odd x is kept: one bezel column, then the white screen.
		const lum = (x: number) => ref.data[(450 * ref.width + x) * 4] as number;
		expect(lum(0)).toBeLessThan(60);
		expect(lum(2)).toBeGreaterThan(200);
		const clone = await captureLines({
			url: dir("pages/clone.html"),
			out: dir("clone"),
			like: dir("ref"),
		});
		expect(clone.join("\n")).not.toContain("clone frames are");
		const c = await readPng(frameFile(dir("clone"), 0));
		expect([c.width, c.height]).toEqual([ref.width, ref.height]);
	}, 240_000);
});

describe("screen geometry helpers", () => {
	it("guesses the css-scale from common phone widths", () => {
		expect(guessCssScale(600)).toMatchObject({ cssScale: 1.5, cssWidth: 400 });
		expect(guessCssScale(1170)).toMatchObject({ cssScale: 3, nearest: 390 });
		expect(guessCssScale(1179)).toMatchObject({ cssScale: 3, nearest: 393 });
		expect(guessCssScale(786)).toMatchObject({ cssScale: 2, nearest: 393 });
		expect(guessCssScale(100)).toBeNull();
	});

	it("trims crops to whole CSS pixels and leaves fitting ones alone", () => {
		expect(fitCropToScale({ x: 659, y: 56, w: 600, h: 1023 }, 1.5)).toEqual({
			crop: { x: 659, y: 56, w: 600, h: 1023 },
		});
		const odd = fitCropToScale({ x: 1, y: 1, w: 601, h: 1024 }, 1.5);
		expect(odd.crop).toEqual({ x: 1, y: 1, w: 600, h: 1023 });
		expect(odd.warning).toContain("trimmed to 1,1,600,1023");
		expect(fitCropToScale({ x: 0, y: 0, w: 801, h: 600 }, 2).crop.w).toBe(800);
	});
});
