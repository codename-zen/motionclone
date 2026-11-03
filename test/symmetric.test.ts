import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { draftSpec } from "../src/spec/draft.ts";
import { verify } from "../src/verify/index.ts";
import type { Verdict } from "../src/verify/schema.ts";
import {
	type CaptureSession,
	GSAP,
	openCaptureSession,
} from "./capture-session.ts";

const ROOT = resolve(import.meta.dirname, "..");
const NOTCH = {
	viewport: { width: 1200, height: 520 },
	durationMs: 1300,
	track: [".art", ".title"],
};

const failing = (v: Verdict) =>
	v.rows.filter((r) => !r.pass).map((r) => r.message);

let session: CaptureSession;
let tmp: string;

beforeAll(async () => {
	session = await openCaptureSession("symmetric");
	tmp = await mkdtemp(join(tmpdir(), "motionclone-symmetric-"));
});

afterAll(async () => {
	await session?.close();
	if (tmp) await rm(tmp, { recursive: true, force: true });
});

// Declared reference rows and a clone measured by a free fit disagreed on an overshooting curve at 30 fps.
describe("verify measures the clone the way the spec measured the reference", () => {
	for (const fps of [30, 60])
		it(`notch-expand at ${fps} fps passes a second capture on every row`, async () => {
			const opts = { ...NOTCH, fps };
			const ref = await session.capture("notch-expand", `ref-${fps}`, opts);
			const spec = await draftSpec(ref, { write: false });
			expect(spec.rows.every((r) => r.source === "declared")).toBe(true);
			const clone = await session.capture("notch-expand", `self-${fps}`, opts);
			const v = await verify(spec, ref, clone, { outDir: false });
			expect(v.setupErrors).toEqual([]);
			expect(failing(v)).toEqual([]);
			expect(v.pass).toBe(true);
		});

	it("a notch-expand page with other text and colours passes at 30 fps", async () => {
		const opts = { ...NOTCH, fps: 30 };
		const ref = await session.capture("notch-expand", "ref-restyled", opts);
		const spec = await draftSpec(ref, { write: false });
		const html = (
			await readFile(join(ROOT, "fixtures/notch-expand/index.html"), "utf8")
		)
			.replace(
				"Night Drive<small>Low Orbit</small>",
				"Sea Glass<small>Tidal</small>",
			)
			.replaceAll("#2f5bff", "#ff6a3d")
			.replaceAll("#9db1ff", "#ffc59d")
			.replace("#e9eeff", "#fff4e9")
			.replace("color: #fff;", "color: #f4e9ff;");
		const page = join(tmp, "restyled.html");
		await writeFile(page, html);
		const clone = await captureMotion({
			...opts,
			url: pathToFileURL(page).href,
			outDir: join(tmp, "restyled"),
		});
		const v = await verify(spec, ref, clone.outDir, { outDir: false });
		expect(v.setupErrors).toEqual([]);
		expect(failing(v)).toEqual([]);
		expect(v.pass).toBe(true);
	});

	it("gsap-timeline, driven by script, passes a second capture at 30 fps", async () => {
		const opts = { ...GSAP, fps: 30 };
		const ref = await session.capture("gsap-timeline", "gsap-ref", opts);
		const spec = await draftSpec(ref, { write: false });
		expect(spec.rows.length).toBeGreaterThan(0);
		expect(spec.rows.every((r) => r.source === "measured")).toBe(true);
		const clone = await session.capture("gsap-timeline", "gsap-self", opts);
		const v = await verify(spec, ref, clone, { outDir: false });
		expect(v.setupErrors).toEqual([]);
		expect(failing(v)).toEqual([]);
		expect(v.pass).toBe(true);
	});
});
