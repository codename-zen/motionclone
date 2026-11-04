import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { deltaEHex } from "../src/look/colour.ts";
import { renderReport } from "../src/report/report.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { LookRow } from "../src/spec/look-schema.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { verify } from "../src/verify/index.ts";
import type { Verdict } from "../src/verify/schema.ts";
import { captureVideo } from "../src/video/index.ts";
import { type StaticServer, serveRepo } from "./serve.ts";
import { encodeFrames, X264 } from "./video-helpers.ts";

const FPS = 56;
const H = 1032;
const PAGE = {
	durationMs: 2800,
	fps: FPS,
	viewport: { width: 600, height: H },
	track: [".sheet"],
};
// The sheet rests at 96 px in the light state and 440 px lower in the dark one, between 700 and 1700 ms.
const DARK_TOP = 96 + 440;
const VARIANTS = ["same", "grey", "square", "low"] as const;

describe("a video reference that rests in a light and a dark state", () => {
	let server: StaticServer;
	let tmp: string;
	let ref: string;
	let spec: SpecFile;
	const verdicts: Record<string, Verdict> = {};

	const capture = async (hash: string, name: string) =>
		(
			await captureMotion({
				...PAGE,
				url: `${server.url}/fixtures/_variants/sheet-flip/index.html${hash}`,
				outDir: join(tmp, name),
			})
		).outDir;

	beforeAll(async () => {
		server = await serveRepo();
		tmp = await mkdtemp(join(tmpdir(), "motionclone look-states-"));
		const page = await capture("", "page");
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
		for (const v of VARIANTS) {
			const clone = v === "same" ? page : await capture(`#${v}`, v);
			verdicts[v] = await verify(spec, ref, clone, {
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

	const row = (id: string) => {
		const r = spec.look?.rows.find((x) => x.id === id);
		if (!r)
			throw new Error(
				`no ${id}; rows: ${spec.look?.rows.map((x) => x.id).join(", ")}`,
			);
		return r as LookRow;
	};
	const failingLook = (name: string) =>
		((verdicts[name] as Verdict).look?.rows ?? [])
			.filter((r) => !r.pass)
			.map((r) => r.id)
			.sort();

	it("drafts look rows for each rest state, labelled by state and time", () => {
		const light = row("look.background");
		const dark = row("dark.look.background");
		expect(light.state?.name).toBe("light");
		expect(deltaEHex(light.colour as string, "#ffffff")).toBeLessThan(3);
		expect(dark.state?.name).toBe("dark");
		expect(deltaEHex(dark.colour as string, "#111114")).toBeLessThan(3);
		const t = dark.state?.t ?? 0;
		expect(t).toBeGreaterThan(700);
		expect(t).toBeLessThan(1700);
		expect(dark.label).toBe(`page background (dark, rest at ${t} ms)`);
		for (const id of ["dark.look.text", "dark.sheet[0].look.type#1"])
			expect(row(id).state?.frame).toBe(dark.state?.frame);
	});

	it("reads text colours per region and outside the regions in each state", () => {
		// Outside the sheet the dark state shows the summary's light greys (#f2f2f5, #9c9ca6) and the grey title, so
		// it gets a row only where one of them holds most of the ink, which depends on the OS's fonts.
		const dark = spec.look?.rows.find((r) => r.id === "dark.look.outside.text");
		if (dark)
			expect(
				Math.min(
					...["#f2f2f5", "#9c9ca6", "#8a8a90"].map((c) =>
						deltaEHex(dark.colour as string, c),
					),
				),
			).toBeLessThan(8);
		expect(
			deltaEHex(row("look.outside.text").colour as string, "#8a8a90"),
		).toBeLessThan(6);
		expect(
			deltaEHex(row("dark.sheet[0].look.text").colour as string, "#1d1d22"),
		).toBeLessThan(8);
		expect(
			deltaEHex(row("sheet[0].look.text").colour as string, "#1d1d22"),
		).toBeLessThan(8);
	});

	it("reads the dark state's panel: its top edge and its 28 px corners", () => {
		const top = row("dark.look.panel.top");
		expect(Math.abs((top.box?.y ?? 0) * H - DARK_TOP)).toBeLessThan(2);
		const radius = row("dark.look.panel.radius");
		expect(Math.abs((radius.px as number) / 28 - 1)).toBeLessThan(0.1);
		expect(radius.tolerances.size).toBe(0.2);
		// White on white: the light state shows no panel edge.
		expect(spec.look?.rows.some((r) => r.id === "look.panel.top")).toBe(false);
	});

	it("passes a page clone of the same design in both states", () => {
		expect(failingLook("same")).toEqual([]);
		const ids = verdicts.same?.look?.rows.map((r) => r.id) ?? [];
		expect(ids).toEqual(
			expect.arrayContaining([
				"dark.look.panel.radius",
				"dark.look.background",
			]),
		);
	});

	it("fails a clone that differs only in its dark state, on that state's rows", () => {
		expect(failingLook("grey")).toEqual(["dark.look.background"]);
		expect(failingLook("square")).toEqual(["dark.look.panel.radius"]);
		expect(failingLook("low")).toContain("dark.look.panel.top");
		for (const name of ["grey", "square", "low"])
			expect(failingLook(name).every((id) => id.startsWith("dark."))).toBe(
				true,
			);
		const report = renderReport(verdicts.square as Verdict);
		expect(report).toMatch(
			/large panel corner radius \(dark, rest at \d+ ms\) 0 px, want [\d.]+ px/,
		);
	});
});
