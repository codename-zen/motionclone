import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTrack, type Track } from "../src/measure/elements.ts";
import { captureVideo, type VideoCaptureSummary } from "../src/video/index.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import { answerOf, boxAt, encodeFrames, X264 } from "./video-helpers.ts";

const FPS = 56;
const VIEWPORT = { width: 600, height: 1032 };
// The visible screen ends 392 px above the page bottom: the frame edge always cuts the sheet, and at its lower
// rest only its top 104 px show.
const CROP = { x: 0, y: 0, w: 600, h: 640 };
const CLIPPED = /reaches past the region edge/;
// The summary sits between the page header and the sheet's lower rest.
const SUMMARY = { y0: 130, y1: 430 };

describe("video input: automatic regions on a crop that cuts the sliding sheet", () => {
	let session: CaptureSession;
	let tmp: string;
	let dom: Track;
	let summary: VideoCaptureSummary;
	let track: Track;

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-sheet-crop-"));
		session = await openCaptureSession("video-sheet-crop");
		const answer = await answerOf("sheet-loop");
		const domDir = await session.capture("sheet-loop", "dom", {
			durationMs: answer.captureMs,
			fps: FPS,
			viewport: VIEWPORT,
			track: [".sheet"],
		});
		dom = await readTrack(domDir);
		const mp4 = join(tmp, "sheet.mp4");
		await encodeFrames(domDir, mp4, FPS, X264);
		summary = await captureVideo({
			input: mp4,
			outDir: join(tmp, "auto"),
			crop: CROP,
		});
		console.log(JSON.stringify(summary.regions), summary.warnings);
		track = await readTrack(summary.outDir);
	}, 600_000);

	afterAll(async () => {
		await session?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	const sheetTop = (k: number) => boxAt(dom.frames[k], ".sheet", 0).y;

	/** Share of frames where the region's box top moves with the sheet's top edge within 3 px. */
	function tracked(name: string): number {
		const [sel, i] = [name.replace(/\[\d+\]$/, ""), Number(/\d+/.exec(name))];
		const top = (k: number) => boxAt(track.frames[k], sel, i).y;
		let ok = 0;
		track.frames.forEach((f, k) => {
			const e = f.elements[sel]?.[i];
			const want = sheetTop(k) - sheetTop(0);
			if (e?.observed?.position && Math.abs(top(k) - top(0) - want) <= 3) ok++;
		});
		return ok / track.frames.length;
	}

	const sheetRegion = () =>
		summary.regions.reduce((a, r) =>
			tracked(r.name) > tracked(a.name) ? r : a,
		);

	it("tracks the sheet's top edge on at least 95 % of frames", () => {
		const share = tracked(sheetRegion().name);
		console.log(
			`sheet edge tracked on ${(share * 100).toFixed(1)} % of frames`,
		);
		expect(share).toBeGreaterThanOrEqual(0.95);
	});

	it("finds the summary as its own region, apart from the sheet edge", () => {
		const sheet = sheetRegion();
		const content = summary.regions.filter(
			(r) =>
				r.name !== sheet.name &&
				r.box.y >= SUMMARY.y0 &&
				r.box.y + r.box.h <= SUMMARY.y1,
		);
		expect(content.length).toBeGreaterThan(0);
	});

	it("does not warn about clipped travel where the frame edge cuts the sheet", () => {
		expect(summary.warnings.filter((w) => CLIPPED.test(w))).toEqual([]);
	});
});
