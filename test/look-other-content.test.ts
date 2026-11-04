import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { renderReport } from "../src/report/report.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { verify } from "../src/verify/index.ts";
import type { Verdict } from "../src/verify/schema.ts";
import { captureVideo } from "../src/video/index.ts";
import { type StaticServer, serveRepo } from "./serve.ts";
import { encodeFrames, X264 } from "./video-helpers.ts";

const FPS = 30;
const PAGE = {
	durationMs: 600,
	fps: FPS,
	viewport: { width: 600, height: 400 },
	track: [".strip"],
};
const VARIANTS = ["same", "one", "small"] as const;

describe("type rows against other content: one-digit dates where the reference has two", () => {
	let server: StaticServer;
	let tmp: string;
	let spec: SpecFile;
	const verdicts: Record<string, Verdict> = {};

	const capture = async (hash: string, name: string) =>
		(
			await captureMotion({
				...PAGE,
				url: `${server.url}/fixtures/date-strip/index.html${hash}`,
				outDir: join(tmp, name),
			})
		).outDir;

	beforeAll(async () => {
		server = await serveRepo();
		tmp = await mkdtemp(join(tmpdir(), "motionclone date-strip-"));
		const page = await capture("", "page");
		const mp4 = join(tmp, "strip.mp4");
		await encodeFrames(page, mp4, FPS, X264);
		const ref = (
			await captureVideo({
				input: mp4,
				outDir: join(tmp, "ref"),
				regions: [{ name: "strip", x: 8, y: 112, w: 584, h: 106 }],
			})
		).outDir;
		spec = await draftSpec(ref, { write: false });
		for (const v of VARIANTS)
			verdicts[v] = await verify(
				spec,
				ref,
				v === "same" ? page : await capture(`#${v}`, v),
				{ fidelity: "look", map: ["strip=.strip"], outDir: false },
			);
	}, 300_000);

	afterAll(async () => {
		await server?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	const typeRows = (name: string) =>
		((verdicts[name] as Verdict).look?.rows ?? []).filter(
			(r) => r.measure === "text-height",
		);

	it("reads a row of two-digit dates, one number to each day, as one text line", () => {
		const dates = (spec.look?.rows ?? [])
			.filter((r) => r.measure === "text-height")
			.flatMap((r) => r.lines)
			.filter((l) => Math.abs(l.y * 400 - 146) < 6);
		// 24 px digits are about 17 px tall, across most of the strip.
		expect(dates).toHaveLength(1);
		expect(dates[0]?.cap).toBeGreaterThan(15);
		expect(dates[0]?.w).toBeGreaterThan(0.7);
	});

	it("passes one-digit dates: the line is read from single digits, or not compared", () => {
		for (const r of typeRows("one")) expect(r.pass, r.message).toBe(true);
		expect(verdicts.one?.look?.pass).toBe(true);
		// The one-digit dates still form a line, so the row is compared, not skipped.
		expect(typeRows("one").every((r) => r.comparable)).toBe(true);
		expect(typeRows("same").every((r) => r.pass && r.comparable)).toBe(true);
	});

	it("still fails the type rows of text 25 % smaller", () => {
		const rows = typeRows("small").filter((r) => r.comparable);
		// The dates, the title and the line under the strip are still found, and every one compared fails.
		expect(rows.length).toBeGreaterThanOrEqual(3);
		for (const r of rows) expect(r.pass, r.message).toBe(false);
		expect(verdicts.small?.look?.pass).toBe(false);
	});

	it("reports a reference line with no counterpart as not comparable, never failing", async () => {
		const ref = spec.look?.rows.find(
			(r) =>
				r.measure === "text-height" &&
				r.lines.some((l) => Math.abs(l.y * 400 - 146) < 6),
		);
		if (!ref) throw new Error("no dates row");
		// The same row moved to an empty stretch under the labels: the labels and the line below are other sizes and must not stand in.
		const moved: SpecFile = {
			...spec,
			look: spec.look && {
				...spec.look,
				rows: [
					{
						...ref,
						lines: ref.lines.map((l) => ({
							...l,
							y: 0.55,
							count: 1,
							rank: 0,
						})),
					},
				],
			},
		};
		const v = await verify(moved, join(tmp, "ref"), join(tmp, "page"), {
			fidelity: "look",
			map: ["strip=.strip"],
			outDir: false,
		});
		const row = v.look?.rows[0];
		expect(row?.comparable).toBe(false);
		expect(row?.pass).toBe(true);
		expect(row?.message).toContain(
			"not comparable: no matching text line in the clone",
		);
		expect(v.look?.summary.notComparable).toBe(1);
		expect(renderReport(v)).toContain("Not comparable");
	});
});
