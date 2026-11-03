import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readLook } from "../src/look/file.ts";
import { readTrack } from "../src/measure/elements.ts";
import { renderReport } from "../src/report/report.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { verify } from "../src/verify/index.ts";
import type { Verdict } from "../src/verify/schema.ts";
import { captureVideo } from "../src/video/index.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import { boxAt, encodeFrames, padded, X264 } from "./video-helpers.ts";

const PAGE = { durationMs: 1200, fps: 30, track: [".card", ".title"] };
const VIDEO = { durationMs: 1200, fps: 60, track: [".card"] };

const failingLook = (v: Verdict) =>
	(v.look?.rows ?? [])
		.filter((r) => !r.pass)
		.map((r) => r.id)
		.sort();
const lookMessage = (v: Verdict, id: string) =>
	v.look?.rows.find((r) => r.id === id)?.message ?? "";
const motionFailures = (v: Verdict) =>
	v.rows.filter((r) => !r.pass).map((r) => r.message);

let session: CaptureSession;

beforeAll(async () => {
	session = await openCaptureSession("look");
}, 60_000);

afterAll(async () => {
	await session?.close();
});

describe("look of a page reference", () => {
	let ref: string;
	let spec: SpecFile;
	const against = async (fixture: string) => {
		const clone = await session.capture(fixture, fixture, PAGE);
		return verify(spec, ref, clone, { fidelity: "look", outDir: false });
	};

	beforeAll(async () => {
		ref = await session.capture("look-card", "ref", PAGE);
		spec = await draftSpec(ref, { write: false });
	}, 120_000);

	it("records styles and a design summary in look.json", async () => {
		const look = await readLook(ref);
		expect(look?.source).toBe("page");
		expect(look?.states.map((s) => s.label)).toEqual(["first", "last"]);
		const last = look?.states.at(-1);
		expect(last?.rest).toBe(true);
		expect(last?.page?.background).toBe("#ffffff");
		const title = last?.page?.elements.find((e) => e.name === "h1.title");
		expect(title).toMatchObject({
			fontSize: 48,
			fontWeight: 700,
			color: "#1f2937",
			letterSpacing: -0.5,
		});
		expect(last?.pixels.background).toBe("#ffffff");
		expect(look?.summary.typeScale.map((t) => t.px)).toEqual([
			48, 22, 18, 16, 15,
		]);
		expect(look?.summary.radii).toEqual([
			{ px: 16, count: 3 },
			{ px: 10, count: 1 },
		]);
		expect(look?.summary.palette.map((p) => p.hex)).toEqual([
			"#ffffff",
			"#eef2ff",
			"#4f46e5",
		]);
		expect(spec.look?.rows.map((r) => r.id)).toEqual(
			expect.arrayContaining([
				"look.background",
				"look.text",
				"look.type.title",
				"look.type.body",
				".title[0].look.font-size",
				".card[1].look.radius",
				"look.block#1",
			]),
		);
	});

	it("passes against itself, rows and structure", async () => {
		const v = await against("look-card");
		expect(v.look?.rows.length).toBeGreaterThanOrEqual(15);
		expect(failingLook(v)).toEqual([]);
		expect(v.look?.structure?.minSsim).toBe(1);
		expect(v.pass).toBe(true);
	});

	it("fails exactly the page background row on another background colour", async () => {
		const v = await against("look-card-bg");
		expect(motionFailures(v)).toEqual([]);
		expect(failingLook(v)).toEqual(["look.background"]);
		expect(lookMessage(v, "look.background")).toBe(
			"page background is #f4f7f1, want #ffffff (ΔE 4.1 > 3)",
		);
		expect(v.look?.structure?.pass).toBe(true);
		expect(v.pass).toBe(false);
		const md = renderReport(v);
		expect(md).toContain("## Look");
		expect(md).toContain(
			"- page background is #f4f7f1, want #ffffff (ΔE 4.1 > 3)",
		);
	});

	it("fails the title type row on a smaller title", async () => {
		const v = await against("look-card-title");
		expect(failingLook(v)).toContain("look.type.title");
		expect(lookMessage(v, "look.type.title")).toBe(
			"title font size 34 px, want 48 px (-29 %, allowed ±8 %)",
		);
		for (const id of failingLook(v)) expect(id).toMatch(/title/);
		expect(v.pass).toBe(false);
	});

	it("passes with other words in the same design", async () => {
		const v = await against("look-card-words");
		expect(failingLook(v)).toEqual([]);
		expect(v.look?.structure?.pass).toBe(true);
		expect(v.pass).toBe(true);
	});

	it("leaves motion fidelity unchanged", async () => {
		const clone = await session.capture("look-card-bg", "bg-motion", PAGE);
		const v = await verify(spec, ref, clone, { outDir: false });
		expect(v.look).toBeNull();
		expect(v.pass).toBe(true);
	});
});

describe("look of a video reference", () => {
	let tmp: string;
	let refDir: string;
	let spec: SpecFile;
	const against = async (fixture: string) => {
		const clone = await session.capture(fixture, `video-${fixture}`, VIDEO);
		return verify(spec, refDir, clone, {
			fidelity: "look",
			map: ["card=.card"],
			outDir: false,
		});
	};

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone-look-video-"));
		const dom = await session.capture("look-card", "video-source", VIDEO);
		const mp4 = join(tmp, "look.mp4");
		await encodeFrames(dom, mp4, VIDEO.fps, X264);
		const last = (await readTrack(dom)).frames.at(-1);
		const regions = [0, 1, 2].map((i) => ({
			name: `card[${i}]`,
			...padded(boxAt(last, ".card", i), 6),
		}));
		const cap = await captureVideo({
			input: mp4,
			outDir: join(tmp, "ref"),
			regions,
		});
		refDir = cap.outDir;
		spec = await draftSpec(refDir, { write: false });
	}, 240_000);

	afterAll(async () => {
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	it("measures the look from rest-frame pixels", async () => {
		const look = await readLook(refDir);
		expect(look?.source).toBe("video");
		expect(look?.states.map((s) => s.label)).toEqual(["first", "last"]);
		expect(look?.states.at(-1)?.pixels.blocks).toHaveLength(4);
		expect(spec.look?.source).toBe("video");
		expect(spec.look?.rows.map((r) => r.id)).toEqual(
			expect.arrayContaining([
				"look.background",
				"look.text",
				"look.accent#1",
				"card[0].look.background",
				"look.block#4",
			]),
		);
		expect(spec.look?.rows.every((r) => r.method === "pixels")).toBe(true);
	});

	it("passes a DOM clone of the same page, rows and structure", async () => {
		const v = await against("look-card");
		expect(v.setupErrors).toEqual([]);
		expect(failingLook(v)).toEqual([]);
		expect(v.look?.structure?.pass).toBe(true);
		expect(v.look?.structure?.minSsim).toBeGreaterThan(0.99);
		expect(v.pass).toBe(true);
	});

	it("fails a DOM clone with another background on the background row", async () => {
		const v = await against("look-card-bg");
		expect(failingLook(v)).toEqual(["look.background"]);
		expect(lookMessage(v, "look.background")).toMatch(
			/^page background is #f4f7f1, want #ffffff \(ΔE 4\.\d > 3\)$/,
		);
		expect(v.pass).toBe(false);
	});
});
