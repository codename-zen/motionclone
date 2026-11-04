import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { readTrack } from "../src/measure/elements.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { verify } from "../src/verify/index.ts";
import type { Verdict } from "../src/verify/schema.ts";
import { captureVideo } from "../src/video/index.ts";
import { type StaticServer, serveRepo } from "./serve.ts";
import { encodeFrames, rowOf, X264 } from "./video-helpers.ts";

const FPS = 56;
const FRAME_MS = 1000 / FPS;
const PAGE = {
	durationMs: 2800,
	fps: FPS,
	viewport: { width: 600, height: 1032 },
	track: [".sheet", ".hdr"],
};
const MAP = ["sheet=.sheet", "header=.hdr"];
const EDGE_ROWS = ["sheet::edge[0].y", "sheet::edge[0].y#2"];
const FADE_ROWS = ["header[0].progress", "header[0].progress#2"];

// The panel slides 440 px: down from 400 ms over 380 ms easeInOutCubic, up from 1700 ms over 240 ms; its content
// slides the same 440 px over 300 ms easeOutCubic both ways. The page is dark from 400 to 2100 ms, where the header
// fades in linearly until 600 ms and out from 1700 to 1790 ms.
describe("video of a sheet whose surface moves apart from its content, under a header that fades on dark", () => {
	let server: StaticServer;
	let tmp: string;
	let ref: string;
	let spec: SpecFile;
	const verdicts: Record<string, Verdict> = {};

	const capture = async (hash: string, name: string) =>
		(
			await captureMotion({
				...PAGE,
				url: `${server.url}/fixtures/_variants/sheet-stretch/index.html${hash}`,
				outDir: join(tmp, name),
			})
		).outDir;

	beforeAll(async () => {
		server = await serveRepo();
		tmp = await mkdtemp(join(tmpdir(), "motionclone sheet-stretch-"));
		const page = await capture("", "page");
		const mp4 = join(tmp, "stretch.mp4");
		await encodeFrames(page, mp4, FPS, X264);
		ref = (
			await captureVideo({
				input: mp4,
				outDir: join(tmp, "ref"),
				regions: [
					{ name: "sheet", x: 0, y: 84, w: 600, h: 948 },
					{ name: "header", x: 20, y: 16, w: 140, h: 68 },
				],
			})
		).outDir;
		spec = await draftSpec(ref, { write: false });
		for (const v of ["same", "rigid", "instant"]) {
			const clone = v === "same" ? page : await capture(`#${v}`, v);
			verdicts[v] = await verify(spec, ref, clone, { map: MAP, outDir: false });
		}
	}, 600_000);

	afterAll(async () => {
		await server?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	const failing = (name: string) =>
		(verdicts[name] as Verdict).rows
			.filter((r) => !r.pass && r.advisory === null)
			.map((r) => r.id)
			.sort();

	it("drafts rows for the panel edge apart from the content it carries", () => {
		const [down, up] = EDGE_ROWS.map((id) => rowOf(spec, id));
		expect(down?.from).toBeCloseTo(96, 0);
		expect(down?.to).toBeCloseTo(536, 0);
		expect(Math.abs((down?.startMs ?? 0) - 400)).toBeLessThan(FRAME_MS);
		expect(Math.abs((down?.durationMs ?? 0) - 380)).toBeLessThan(2 * FRAME_MS);
		expect(down?.easing).toMatchObject({ name: "easeInOutCubic" });
		expect(up?.to).toBeCloseTo(96, 0);
		expect(Math.abs((up?.startMs ?? 0) - 1700)).toBeLessThan(FRAME_MS);
		// An ease-out tail settles slowly: the fit's end lands within the default 80 ms tolerance.
		expect(Math.abs((up?.durationMs ?? 0) - 240)).toBeLessThan(80);
		for (const r of [down, up]) expect(r?.confidence).toBe("high");
		expect(rowOf(spec, "sheet[0].y").durationMs).toBeCloseTo(300, -1);
	});

	it("tracks the header on the dark page too, against the dark backdrop", async () => {
		const track = await readTrack(ref);
		const at = (ms: number) =>
			track.frames.find((f) => f.t >= ms)?.elements.header?.[0];
		expect(at(300)).toMatchObject({ opacity: 1, flipped: false });
		expect(at(1000)).toMatchObject({ opacity: 1, flipped: true });
		expect(at(500)?.opacity).toBeGreaterThan(0.3);
		expect(at(500)?.opacity).toBeLessThan(0.8);
	});

	it("drafts the header's fades on the dark page, read between the backdrop flips", () => {
		const [fadeIn, fadeOut] = FADE_ROWS.map((id) => rowOf(spec, id));
		// The first dark frame already shows the fade at 6 %; the row runs from there to its end at 600 ms.
		expect(Math.abs((fadeIn?.startMs ?? 0) - 411)).toBeLessThan(FRAME_MS);
		expect(
			Math.abs((fadeIn?.startMs ?? 0) + (fadeIn?.durationMs ?? 0) - 600),
		).toBeLessThan(FRAME_MS);
		expect(Math.abs((fadeOut?.startMs ?? 0) - 1700)).toBeLessThan(FRAME_MS);
		// The frame after a short fade can read a few % off the rest after it, which the fit may take for a settle.
		expect(fadeOut?.durationMs).toBeGreaterThan(90 - FRAME_MS);
		expect(fadeOut?.durationMs).toBeLessThan(200);
		expect(fadeIn?.easing).toEqual({ type: "linear" });
		for (const r of [fadeIn, fadeOut]) {
			expect(r?.within).toBeDefined();
		}
	});

	it("passes a page clone of the same design, edge and fade rows included", () => {
		expect(failing("same")).toEqual([]);
		const checked = (verdicts.same as Verdict).rows
			.filter((r) => r.advisory === null)
			.map((r) => r.id);
		expect(checked).toEqual(
			expect.arrayContaining([...EDGE_ROWS, ...FADE_ROWS]),
		);
		expect(verdicts.same?.status).toBe("pass");
	});

	it("fails a clone whose panel moves rigidly with its content, on the edge rows only", () => {
		expect(failing("rigid")).toEqual(EDGE_ROWS);
	});

	it("fails a clone that shows and hides the header at once, on the fade rows only", () => {
		const bad = failing("instant");
		expect(bad).toEqual(expect.arrayContaining(FADE_ROWS));
		// Where the font draws the header without distortion, its opacity rows stay checked and fail too.
		expect(bad.every((id) => id.startsWith("header[0]."))).toBe(true);
	});
});
