import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { captureVideo, type VideoCaptureSummary } from "../src/video/index.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import { encodeFrames, X264 } from "./video-helpers.ts";

const FPS = 56;
const FRAME_MS = 1000 / FPS;
// The sheet slides 440 px in 300 ms at these times; its content rides 28 px up inside it on the way down.
const SLIDES = [400, 2300, 4400, 6300];
const DURATION_MS = 300;
// The screen ends where only the week strip shows at the sheet's lower rest, as in the phone recording.
const CROP = { x: 0, y: 0, w: 600, h: 600 };
const SHEET = { name: "sheet", x: 0, y: 84, w: 600, h: 516 };
const UNTRACKED = /reaches past the region edge|was lost on frames/;

interface Run {
	summary: VideoCaptureSummary;
	spec: SpecFile;
}

describe("video input: a white sheet that blends into a white page for half of each slide", () => {
	let session: CaptureSession;
	let tmp: string;
	const runs: Record<string, Run> = {};

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-sheet-blend-"));
		session = await openCaptureSession("video-sheet-blend");
		const domDir = await session.capture("_variants/sheet-blend", "dom", {
			durationMs: 8000,
			fps: FPS,
			viewport: { width: 600, height: 1032 },
			track: [".sheet"],
		});
		const mp4 = join(tmp, "sheet.mp4");
		await encodeFrames(domDir, mp4, FPS, X264);
		const inputs = { declared: [SHEET], auto: undefined };
		for (const [name, regions] of Object.entries(inputs)) {
			const summary = await captureVideo({
				input: mp4,
				outDir: join(tmp, name),
				crop: CROP,
				regions,
			});
			console.log(name, JSON.stringify(summary.regions), summary.warnings);
			runs[name] = {
				summary,
				spec: await draftSpec(summary.outDir, { write: false }),
			};
		}
	}, 600_000);

	afterAll(async () => {
		await session?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	/** The y rows of the region that drafts the most long moves. */
	function slides(r: Run) {
		const moves = r.spec.rows.filter(
			(row) =>
				row.property === "y" &&
				Math.abs(Number(row.to) - Number(row.from)) >= 300,
		);
		const bySelector = Map.groupBy(moves, (row) => row.selector);
		const rows = [...bySelector.values()].reduce(
			(a, b) => (b.length > a.length ? b : a),
			[],
		);
		return rows.sort((a, b) => a.startMs - b.startMs);
	}

	for (const name of ["declared", "auto"])
		describe(
			name === "auto" ? "automatic regions" : "a declared region",
			() => {
				it("drafts the four slides with the key's starts and durations", () => {
					const rows = slides(runs[name] as Run);
					for (const r of rows)
						console.log(
							`${name} ${r.id}: ${r.from} -> ${r.to}, start ${r.startMs}, duration ${r.durationMs}, ${r.confidence}`,
						);
					expect(rows).toHaveLength(SLIDES.length);
					rows.forEach((r, i) => {
						expect(
							Math.abs(r.startMs - (SLIDES[i] as number)),
						).toBeLessThanOrEqual(2 * FRAME_MS);
						expect(Math.abs(r.durationMs - DURATION_MS)).toBeLessThanOrEqual(
							40,
						);
					});
				});

				it("finds the sheet on every slide without lost or clipped travel warnings", () => {
					const { summary } = runs[name] as Run;
					expect(summary.warnings.filter((w) => UNTRACKED.test(w))).toEqual([]);
					const found = Math.max(...summary.regions.map((r) => r.foundFrames));
					expect(found).toBeGreaterThanOrEqual(0.98 * 449);
				});
			},
		);
});
