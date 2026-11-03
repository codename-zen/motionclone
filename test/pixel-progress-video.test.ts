import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CaptureInput, captureMotion } from "../src/capture/index.ts";
import { readTrack } from "../src/measure/elements.ts";
import { readCaptureFile } from "../src/spec/capture-file.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { verify } from "../src/verify/index.ts";
import { captureVideo } from "../src/video/index.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import {
	DIM,
	expectTiming,
	FPS,
	failing,
	HEADER,
	linearGap,
	PAGE,
	REVEAL,
	VIEWPORT,
	variantPage,
} from "./progress-helpers.ts";
import { encodeFrames, padded, rowOf, sweep, X264 } from "./video-helpers.ts";

describe(`${PAGE}: a video of the page`, () => {
	let session: CaptureSession;
	let tmp: string;
	let refDir: string;
	let spec: SpecFile;
	let clone: Omit<CaptureInput, "url" | "outDir">;

	beforeAll(async () => {
		session = await openCaptureSession("pixel-progress-video");
		tmp = await mkdtemp(join(tmpdir(), "motionclone-pixel-progress-video-"));
		const dom = await session.capture(PAGE, "dom", {
			fps: FPS,
			viewport: VIEWPORT,
			durationMs: 2000,
			track: [".card"],
		});
		const card = padded(sweep(await readTrack(dom), ".card"), 12);
		await encodeFrames(dom, join(tmp, "page.mp4"), FPS, X264);
		const video = await captureVideo({
			input: join(tmp, "page.mp4"),
			outDir: join(tmp, "ref"),
			regions: [
				{ name: "card", ...card },
				{ name: "header", ...HEADER },
			],
		});
		refDir = video.outDir;
		spec = await draftSpec(refDir, { write: false });
		for (const r of spec.rows)
			console.log(r.id, r.startMs, r.durationMs, r.confidence, r.notes.at(-1));
		const ref = await readCaptureFile(refDir);
		// What `capture --like` takes from a video reference.
		clone = {
			fps: ref.options.fps,
			durationMs: ref.options.durationMs,
			trigger: { type: "load" },
			preRollMs: 0,
			viewport: VIEWPORT,
			track: [".card", ".header"],
		};
	}, 240_000);

	afterAll(async () => {
		await session?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	const verifyClone = async (name: string, url?: string) => {
		const dir = url
			? (await captureMotion({ ...clone, url, outDir: join(tmp, name) })).outDir
			: await session.capture(PAGE, name, clone);
		return verify(spec, refDir, dir, {
			map: ["card=.card", "header=.header"],
			outDir: false,
		});
	};

	it("drafts a progress row for the reveal in the card and the dim in the header", () => {
		const card = rowOf(spec, "card[0].progress");
		expectTiming(card, REVEAL);
		expect(linearGap(card.easing)).toBeLessThanOrEqual(0.05);
		expectTiming(rowOf(spec, "header[0].progress"), DIM);
		for (const r of [card, rowOf(spec, "header[0].progress")]) {
			expect(r.source).toBe("measured");
			expect(r.confidence).not.toBe("low");
			expect(r.support?.samples).toBeGreaterThanOrEqual(6);
		}
	});

	it("a clone of the same page passes every row", async () => {
		const v = await verifyClone("same");
		expect(v.setupErrors).toEqual([]);
		expect(failing(v).map((r) => r.message)).toEqual([]);
		expect(v.pass).toBe(true);
		for (const id of ["card[0].progress", "header[0].progress"])
			expect(v.rows.find((r) => r.id === id)?.pass).toBe(true);
	}, 120_000);

	it("fails the card progress row when the reveal starts 120 ms late", async () => {
		const v = await verifyClone("late", await variantPage(tmp, "late"));
		const row = v.rows.find((r) => r.id === "card[0].progress");
		console.log(row?.message);
		expect(row?.pass).toBe(false);
		expect(row?.message).toContain("card[0] progress starts");
		expect(row?.metrics.start?.got).toBeGreaterThan(1600);
		expect(v.pass).toBe(false);
	}, 120_000);

	it("fails the header progress row when the dim runs 339 ms material-emphasized", async () => {
		const v = await verifyClone("dim", await variantPage(tmp, "dim"));
		const row = v.rows.find((r) => r.id === "header[0].progress");
		console.log(row?.message);
		expect(row?.pass).toBe(false);
		expect(row?.message).toContain("header[0] progress");
		expect(v.pass).toBe(false);
	}, 120_000);
});
