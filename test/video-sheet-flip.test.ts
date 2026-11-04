import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { pixelLook } from "../src/look/pixels.ts";
import { capsAt } from "../src/look/type.ts";
import { renderReport } from "../src/report/report.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { verify } from "../src/verify/index.ts";
import { readPng } from "../src/verify/pixels.ts";
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
	track: [".sheet"],
};
// The page flips its background in one frame at 400 and 1700 ms while the sheet slides down and back up.
const FLIPS = [400, 1700];
const SWITCH =
	/^frame\[0\] progress takes \d+ ms, want 18 ms \(a near-instant switch\)$/;

describe("video of a page that flips its background while a sheet slides, rebuilt as a page", () => {
	let server: StaticServer;
	let tmp: string;
	let ref: string;
	let page: string;
	let spec: SpecFile;
	const clones: Record<string, string> = {};
	const verdicts: Record<string, Verdict> = {};

	const capture = async (hash: string, name: string, opts = {}) =>
		(
			await captureMotion({
				...PAGE,
				...opts,
				url: `${server.url}/fixtures/_variants/sheet-flip/index.html${hash}`,
				outDir: join(tmp, name),
			})
		).outDir;

	beforeAll(async () => {
		server = await serveRepo();
		tmp = await mkdtemp(join(tmpdir(), "motionclone sheet-flip-"));
		page = await capture("", "page");
		const mp4 = join(tmp, "flip.mp4");
		await encodeFrames(page, mp4, FPS, X264);
		ref = (
			await captureVideo({
				input: mp4,
				outDir: join(tmp, "ref"),
				regions: [{ name: "sheet", x: 0, y: 84, w: 600, h: 948 }],
			})
		).outDir;
		spec = await draftSpec(ref, { write: false });
		for (const v of ["same", "fade", "small", "words"]) {
			clones[v] = await capture(v === "same" ? "" : `#${v}`, v);
			verdicts[v] = await verify(spec, ref, clones[v] as string, {
				fidelity: "look",
				map: ["sheet=.sheet"],
				outDir: false,
			});
		}
	}, 600_000);

	afterAll(async () => {
		await server?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	const failing = (name: string) =>
		(verdicts[name] as Verdict).rows.filter((r) => !r.pass);
	const failingLook = (name: string) =>
		((verdicts[name] as Verdict).look?.rows ?? [])
			.filter((r) => !r.pass)
			.map((r) => r.id)
			.sort();
	const text = (name: string) =>
		((verdicts[name] as Verdict).look?.structure?.frames ?? []).map(
			(f) => f.text ?? 0,
		);

	it("drafts one switch row per flip of the frame's background", () => {
		const rows = spec.rows.filter((r) => r.selector === "frame");
		expect(rows.map((r) => r.id)).toEqual([
			"frame[0].progress",
			"frame[0].progress#2",
		]);
		rows.forEach((r, i) => {
			expect(r.easing).toEqual({ type: "steps", count: 1, position: "end" });
			expect(r.durationMs).toBeLessThanOrEqual(FRAME_MS + 1);
			expect(r.confidence).toBe("high");
			expect(
				Math.abs(r.startMs + r.durationMs - (FLIPS[i] as number)),
			).toBeLessThanOrEqual(FRAME_MS);
		});
		expect(rowOf(spec, "frame[0].progress").notes.join(" ")).toContain(
			"a near-instant switch",
		);
	});

	it("drafts type sizes from the video's text lines, per region and outside them", async () => {
		// Rows of the last rest state; the dark state has its own (test/look-states.test.ts).
		const rows =
			spec.look?.rows.filter(
				(r) => r.measure === "text-height" && !r.id.startsWith("dark."),
			) ?? [];
		expect(rows.map((r) => r.id)).toEqual([
			"look.type#1",
			"look.type#2",
			"sheet[0].look.type#1",
			"sheet[0].look.type#2",
		]);
		expect(rows[2]?.lines).toHaveLength(7);
		// The page's own pixels on the same frame, read the same way: equal sizes on any OS and its fonts.
		const frame = spec.look?.frames.at(-1)?.frame ?? 0;
		const own = pixelLook(await readPng(page, frame), {
			x: 0,
			y: 0,
			...PAGE.viewport,
		}).lines;
		for (const r of rows) {
			const caps = capsAt(r.lines, own, PAGE.viewport.height).sort(
				(a, b) => a - b,
			);
			const want = caps[caps.length >> 1] as number;
			expect(Math.abs((r.px as number) / want - 1)).toBeLessThan(0.05);
		}
		const [title, , body] = rows.map((r) => r.px as number);
		expect((title as number) / (body as number)).toBeGreaterThan(1.1);
	});

	it("passes a page clone of the same design", () => {
		expect(failing("same").map((r) => r.message)).toEqual([]);
		expect(failingLook("same")).toEqual([]);
		expect(verdicts.same?.status).toBe("pass");
		const untracked = (verdicts.same?.coverage?.warnings ?? []).filter(
			(w) =>
				w.rule === "untracked-motion" &&
				FLIPS.some((t) => w.fromMs <= t && w.toMs >= t),
		);
		expect(untracked.map((w) => w.message)).toEqual([]);
	});

	it("fails a clone that fades its background over 260 ms, with the switch message", () => {
		const bad = failing("fade");
		expect(bad.map((r) => r.id)).toEqual([
			"frame[0].progress",
			"frame[0].progress#2",
		]);
		for (const r of bad) expect(r.message).toMatch(SWITCH);
		const got = bad[0]?.metrics.duration?.got ?? 0;
		expect(got).toBeGreaterThan(200);
		expect(got).toBeLessThan(300);
	});

	it("fails text 25 % smaller on its type rows and its text score", () => {
		const v = verdicts.small as Verdict;
		// Thinner glyphs also read lighter where the OS draws them thin (Linux: ΔE 8.7), so text colours may fail too.
		const last = failingLook("small").filter((id) => !id.startsWith("dark."));
		expect(last.filter((id) => !id.endsWith("look.text"))).toEqual([
			"look.type#1",
			"look.type#2",
			"sheet[0].look.type#1",
			"sheet[0].look.type#2",
		]);
		expect(failingLook("small")).toEqual(
			expect.arrayContaining(["dark.look.type#1", "dark.sheet[0].look.type#1"]),
		);
		const body = v.look?.rows.find((r) => r.id === "sheet[0].look.type#1");
		expect(body?.diff).toBeLessThan(-0.2);
		expect(body?.message).toMatch(
			/^sheet\[0\] text cap height [\d.]+ px, want [\d.]+ px \(-\d+ %, allowed ±8 %\)$/,
		);
		expect(Math.max(...text("small"))).toBeLessThan(0.75);
		expect(v.look?.structure?.pass).toBe(false);
		expect(v.status).toBe("fail");
	});

	it("passes other words of the same size, type rows and text score included", () => {
		expect(failingLook("words")).toEqual([]);
		expect(Math.min(...text("words"))).toBeGreaterThan(0.97);
		expect(verdicts.words?.status).toBe("pass");
	});

	it("reports the reduced-motion check, and why it cannot run", async () => {
		const reduced = await capture("", "reduced", { reducedMotion: "reduce" });
		const v = await verify(spec, ref, clones.same as string, {
			map: ["sheet=.sheet"],
			reducedClone: reduced,
			outDir: false,
		});
		expect(v.reducedMotion?.pass).toBe(false);
		expect(v.reducedMotion?.unchanged.length).toBeGreaterThan(0);
		expect(v.reducedMotion?.moved.join(" ")).toContain("sheet[0]");
		expect(renderReport(v)).toContain("## Reduced motion: FAIL");
		const notReduced = await verify(spec, ref, clones.same as string, {
			map: ["sheet=.sheet"],
			reducedClone: clones.words,
			outDir: false,
		});
		expect(notReduced.reducedMotion?.pass).toBeNull();
		expect(notReduced.reducedMotion?.message).toContain(
			"without --reduced-motion",
		);
		expect(renderReport(notReduced)).toContain(
			"## Reduced motion: not checked",
		);
	}, 120_000);
});
