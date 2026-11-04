import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Answer } from "../fixtures/answer-schema.ts";
import { readTrack, type Track } from "../src/measure/elements.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { captureVideo, type VideoCaptureSummary } from "../src/video/index.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import { answerOf, boxAt, encodeFrames, X264 } from "./video-helpers.ts";

const FPS = 56;
const FRAME_MS = 1000 / FPS;
const VIEWPORT = { width: 600, height: 1032 };
const CLIPPED = /reaches past the region edge/;
// The sheet rests with its top at 96 px and slides 440 px down: this region holds it at both rests.
const COVERS = { name: "sheet", x: 0, y: 84, w: 600, h: 948 };
// This one ends 52 px under the sheet's first rest, so the slide leaves it.
const SHORT = { name: "sheet", x: 0, y: 84, w: 600, h: 500 };

interface Run {
	summary: VideoCaptureSummary;
	track: Track;
	spec: SpecFile;
}

describe("video input: a looping sheet over a page that flips from light to dark", () => {
	let session: CaptureSession;
	let tmp: string;
	let dom: Track;
	let answer: Answer;
	const runs: Record<string, Run> = {};

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-sheet-loop-"));
		session = await openCaptureSession("video-sheet-loop");
		answer = await answerOf("sheet-loop");
		const domDir = await session.capture("sheet-loop", "dom", {
			durationMs: answer.captureMs,
			fps: FPS,
			viewport: VIEWPORT,
			track: [".sheet"],
		});
		dom = await readTrack(domDir);
		const mp4 = join(tmp, "sheet.mp4");
		await encodeFrames(domDir, mp4, FPS, X264);
		const inputs = { covers: [COVERS], auto: undefined, short: [SHORT] };
		for (const [name, regions] of Object.entries(inputs)) {
			const started = performance.now();
			const summary = await captureVideo({
				input: mp4,
				outDir: join(tmp, name),
				regions,
			});
			console.log(
				`${name}: ${((performance.now() - started) / 1000).toFixed(1)} s`,
				JSON.stringify(summary.regions),
				summary.warnings,
			);
			runs[name] = {
				summary,
				track: await readTrack(summary.outDir),
				spec: await draftSpec(summary.outDir, { write: false }),
			};
		}
	}, 600_000);

	afterAll(async () => {
		await session?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	const run = (name: string) => runs[name] as Run;
	// The track keys elements by selector: region "blob[0]" is selector "blob", index 0.
	const selectorOf = (r: Run) =>
		(r.summary.regions[0]?.name ?? "").replace(/\[\d+\]$/, "");

	/** Frames whose box top moves with the sheet's top edge within 3 px, from frame 0. */
	function trackedTop(r: Run): number {
		const name = selectorOf(r);
		const top = (t: Track, sel: string, k: number) =>
			boxAt(t.frames[k], sel, 0).y;
		let ok = 0;
		r.track.frames.forEach((f, k) => {
			const e = f.elements[name]?.[0];
			const want = top(dom, ".sheet", k) - top(dom, ".sheet", 0);
			const got = top(r.track, name, k) - top(r.track, name, 0);
			if (e?.observed?.position && Math.abs(got - want) <= 3) ok++;
		});
		return ok / r.track.frames.length;
	}

	for (const name of ["covers", "auto"])
		describe(
			name === "auto" ? "automatic regions" : "a region over the whole travel",
			() => {
				it("tracks the sheet's top edge on at least 95 % of frames", () => {
					const share = trackedTop(run(name));
					console.log(
						`${name}: top edge tracked on ${(share * 100).toFixed(1)} % of frames`,
					);
					expect(share).toBeGreaterThanOrEqual(0.95);
				});

				it("drafts the four slides with the key's starts and durations", () => {
					const rows = run(name)
						.spec.rows.filter((r) => r.property === "y")
						.sort((a, b) => a.startMs - b.startMs);
					for (const r of rows)
						console.log(
							`${name} ${r.id}: ${r.from} -> ${r.to}, start ${r.startMs}, duration ${r.durationMs}, ${r.confidence}`,
						);
					expect(rows).toHaveLength(answer.rows.length);
					rows.forEach((r, i) => {
						const key = answer.rows[i] as Answer["rows"][number];
						expect(Math.abs(r.startMs - key.startMs)).toBeLessThanOrEqual(
							2 * FRAME_MS,
						);
						expect(Math.abs(r.durationMs - key.durationMs)).toBeLessThanOrEqual(
							40,
						);
					});
				});

				it("warns about no clipped travel", () => {
					expect(
						run(name).summary.warnings.filter((w) => CLIPPED.test(w)),
					).toEqual([]);
				});
			},
		);

	it("never returns the whole screen as one automatic region", () => {
		const regions = run("auto").summary.regions;
		expect(regions.length).toBeGreaterThan(0);
		for (const { box } of regions)
			expect(box.w * box.h).toBeLessThan(
				0.9 * VIEWPORT.width * VIEWPORT.height,
			);
	});

	it("warns, naming the region, when the region does not cover the travel", async () => {
		const r = run("short");
		const warnings = r.summary.warnings.filter((w) => CLIPPED.test(w));
		console.log(warnings);
		expect(warnings.length).toBeGreaterThan(0);
		for (const w of warnings)
			expect(w).toMatch(/^region sheet: .* frames \d+-\d+/);
		const cap = JSON.parse(
			await readFile(join(r.summary.outDir, "capture.json"), "utf8"),
		);
		const clipped = cap.video.clippedTravel as {
			fromMs: number;
			toMs: number;
		}[];
		expect(clipped.length).toBe(warnings.length);
		// Each slide down starts inside a clipped range, and those frames are not observed.
		for (const key of answer.rows.filter((k) => k.to === 440))
			expect(
				clipped.some(
					(c) =>
						c.fromMs <= key.startMs + FRAME_MS &&
						c.toMs >= key.startMs + key.durationMs,
				),
			).toBe(true);
		const flagged = r.track.frames.filter((f) => {
			const e = f.elements.sheet?.[0] as {
				clipped?: boolean;
				observed?: { position: boolean };
			};
			return e.clipped === true && e.observed?.position === false;
		});
		expect(flagged.length).toBeGreaterThan(0);
	});
});
