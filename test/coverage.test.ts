import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderReport } from "../src/report/report.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { verify } from "../src/verify/index.ts";
import type { Verdict } from "../src/verify/schema.ts";
import {
	BLUR,
	type CaptureSession,
	FADE,
	openCaptureSession,
} from "./capture-session.ts";

const failingIds = (v: Verdict) =>
	v.rows
		.filter((r) => !r.pass)
		.map((r) => r.id)
		.sort();

const messageOf = (v: Verdict, id: string) =>
	v.rows.find((r) => r.id === id)?.message ?? "";

let session: CaptureSession;
let fade: { dir: string; spec: SpecFile };

beforeAll(async () => {
	session = await openCaptureSession("coverage");
	const dir = await session.capture("css-fade-up-stagger", "fade-ref", FADE);
	fade = { dir, spec: await draftSpec(dir) };
}, 60_000);

afterAll(async () => {
	await session?.close();
});

describe("blur and scale", () => {
	let ref: { dir: string; spec: SpecFile };
	beforeAll(async () => {
		const dir = await session.capture("css-blur-scale-in", "blur-ref", BLUR);
		ref = { dir, spec: await draftSpec(dir) };
	}, 60_000);

	it("css-blur-scale-in captured again passes with no coverage warnings", async () => {
		const clone = await session.capture("css-blur-scale-in", "blur-self", BLUR);
		const v = await verify(ref.spec, ref.dir, clone, { fidelity: "pixel" });
		expect(failingIds(v)).toEqual([]);
		expect(v.pass).toBe(true);
		expect(v.coverage?.warnings).toEqual([]);
		expect(v.coverage?.source).toBe("page");
		expect(v.coverage?.elements.find((e) => e.id === ".card[1]")).toMatchObject(
			{
				rows: ["opacity", "scale", "blur"],
				notMeasured: ["colour", "background", "shadow", "clip-path", "content"],
			},
		);
		const md = renderReport(v);
		expect(md.split("\n")[0]).toBe("# motionclone verify: PASS");
		expect(md).toContain(
			"- .card[0], .card[1], .card[2]: rows opacity, scale, blur; not measured: colour, background, shadow, clip-path, content",
		);
		expect(md).not.toContain("## Coverage warnings");
	});

	it("a clone without blur and scale fails exactly those rows, by name", async () => {
		const clone = await session.capture(
			"_variants/blur-scale-missing",
			"blur-missing",
			BLUR,
		);
		const v = await verify(ref.spec, ref.dir, clone, { outDir: false });
		expect(failingIds(v)).toEqual(
			[0, 1, 2]
				.flatMap((i) => [`.card[${i}].blur`, `.card[${i}].scale`])
				.sort(),
		);
		for (const i of [0, 1, 2]) {
			const start = 150 + 100 * i;
			expect(messageOf(v, `.card[${i}].blur`)).toBe(
				`.card[${i}] blur missing: want 12 px -> 0 px from ${start} ms over 600 ms, the clone never blurs`,
			);
			expect(messageOf(v, `.card[${i}].scale`)).toBe(
				`.card[${i}] scale missing: want 0.92 -> 1 from ${start} ms over 600 ms, the clone never scales`,
			);
		}
	});
});

describe("coverage warnings", () => {
	it("motion outside every tracked element is reported as untracked", async () => {
		const opts = { ...FADE, track: [".card:first-child", "h1"] };
		const dir = await session.capture("css-fade-up-stagger", "part-ref", opts);
		const spec = await draftSpec(dir);
		const clone = await session.capture(
			"css-fade-up-stagger",
			"part-clone",
			opts,
		);
		const v = await verify(spec, dir, clone, { outDir: false });
		expect(v.pass).toBe(true);
		const warnings = v.coverage?.warnings ?? [];
		expect(warnings.map((w) => w.rule)).toEqual(["untracked-motion"]);
		const w = warnings[0];
		// Card 2 starts at 290 ms, card 4 settles before 1170 ms.
		expect(w?.fromMs).toBeGreaterThanOrEqual(250);
		expect(w?.fromMs).toBeLessThanOrEqual(300);
		expect(w?.toMs).toBeLessThanOrEqual(1170);
		expect(w?.message).toMatch(
			/^untracked motion: visible change from \d+ to \d+ ms outside every tracked element around x \d+, y \d+, \d+x\d+ px; track it to measure it$/,
		);
		const md = renderReport(v);
		expect(md.split("\n")[0]).toBe(
			"# motionclone verify: PASS with 1 coverage warning",
		);
		expect(md).toContain(`- ${w?.message}`);
	});

	it("change inside a tracked element that no row explains names the element", async () => {
		const spec = structuredClone(fade.spec);
		spec.rows = spec.rows.filter((r) => r.index !== 2);
		const v = await verify(spec, fade.dir, fade.dir, {
			outDir: false,
		});
		expect(v.pass).toBe(true);
		const warnings = v.coverage?.warnings ?? [];
		expect(warnings.map((w) => `${w.rule} ${w.target}`)).toEqual([
			"unexplained-change .card[2]",
		]);
		// Card 3 starts at 380 ms and runs 700 ms.
		expect(warnings[0]?.fromMs).toBeGreaterThanOrEqual(340);
		expect(warnings[0]?.fromMs).toBeLessThanOrEqual(400);
		expect(warnings[0]?.message).toMatch(
			/^\.card\[2\]: visible change from \d+ to \d+ ms that no row explains \(/,
		);
	});
});
