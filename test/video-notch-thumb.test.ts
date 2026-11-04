import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTrack, type Track } from "../src/measure/elements.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { captureVideo } from "../src/video/index.ts";
import type { RegionTrack } from "../src/video/samples.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import { encodeFrames, padded, sweep, X264 } from "./video-helpers.ts";

const FPS = 60;
// The art starts entering at 450 ms; the compact thumbnail in its colours leaves from 300 ms in the same place.
const ENTERS_MS = 450;
const ART_ROWS = ["opacity", "scale", "y", "blur"];

describe("video input: a notch thumbnail that looks like the art which replaces it", () => {
	let session: CaptureSession;
	let tmp: string;
	let dom: Track;
	let art: RegionTrack;
	let spec: SpecFile;

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-notch-thumb-"));
		session = await openCaptureSession("video-notch-thumb");
		const domDir = await session.capture(
			"_variants/notch-thumb-on-art",
			"dom",
			{
				durationMs: 1200,
				fps: FPS,
				viewport: { width: 1200, height: 520 },
				track: [".art", ".title"],
			},
		);
		dom = await readTrack(domDir);
		await encodeFrames(domDir, join(tmp, "notch.mp4"), FPS, X264);
		const summary = await captureVideo({
			input: join(tmp, "notch.mp4"),
			outDir: join(tmp, "video"),
			regions: [
				{ name: "art", ...padded(sweep(dom, ".art"), 6) },
				{ name: "title", ...padded(sweep(dom, ".title"), 6) },
			],
		});
		art = JSON.parse(
			await readFile(join(summary.outDir, "regions.json"), "utf8"),
		).regions[0];
		spec = await draftSpec(summary.outDir, { write: false });
	}, 240_000);

	afterAll(async () => {
		await session?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	it("does not take the thumbnail for the art", () => {
		const first = art.samples.findIndex((s) => s.found);
		console.log(
			`art first found on frame ${first} (${dom.frames[first]?.t} ms); methods ${[...new Set(art.samples.map((s) => s.method))].join(", ")}`,
		);
		expect(dom.frames[first]?.t).toBeGreaterThanOrEqual(ENTERS_MS);
		for (const s of art.samples)
			if (s.found) expect(s.scale).toBeGreaterThan(0.6);
	});

	it("drafts the art rows with medium or high confidence", () => {
		for (const p of ART_ROWS) {
			const row = spec.rows.find((r) => r.id === `art[0].${p}`);
			console.log(
				`art[0].${p}: ${row?.from} -> ${row?.to}, start ${row?.startMs}, ${row?.confidence} ${JSON.stringify(row?.support?.weak)}`,
			);
			expect(["medium", "high"]).toContain(row?.confidence);
		}
	});
});
