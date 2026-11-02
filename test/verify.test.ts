import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listFixtures } from "../fixtures/index.ts";
import { renderReport, writeReport } from "../src/report/report.ts";
import { writeSheets } from "../src/report/sheet.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { guardrails } from "../src/verify/guardrails.ts";
import { verify } from "../src/verify/index.ts";
import type { Verdict } from "../src/verify/schema.ts";
import {
	type CaptureSession,
	FADE,
	GSAP,
	openCaptureSession,
	SPRING,
} from "./capture-session.ts";

const CARD_ROWS = [0, 1, 2, 3].flatMap((i) => [
	`.card[${i}].opacity`,
	`.card[${i}].translateY`,
]);

const failingIds = (v: Verdict) =>
	v.rows
		.filter((r) => !r.pass)
		.map((r) => r.id)
		.sort();

const messageOf = (v: Verdict, id: string) =>
	v.rows.find((r) => r.id === id)?.message ?? "";

function logVerdict(name: string, v: Verdict) {
	console.log(
		`${name}: ${v.summary.passed}/${v.summary.rows} pass\n${v.rows
			.filter((r) => !r.pass)
			.map((r) => `  ${r.message}`)
			.join("\n")}`,
	);
}

let session: CaptureSession;
const refs: Record<
	"fade" | "spring" | "gsap",
	{ dir: string; spec: SpecFile }
> = {} as never;

beforeAll(async () => {
	session = await openCaptureSession("verify");
	for (const [name, path, opts] of [
		["fade", "css-fade-up-stagger", FADE],
		["spring", "motion-spring", SPRING],
		["gsap", "gsap-timeline", GSAP],
	] as const) {
		const dir = await session.capture(path, `${name}-ref`, opts);
		refs[name] = { dir, spec: await draftSpec(dir) };
	}
}, 120_000);

afterAll(async () => {
	await session?.close();
});

describe("self-verify", () => {
	for (const [name, path, opts] of [
		["fade", "css-fade-up-stagger", FADE],
		["spring", "motion-spring", SPRING],
		["gsap", "gsap-timeline", GSAP],
	] as const)
		it(`${path} captured again passes every row with no pixel mismatch`, async () => {
			const ref = refs[name];
			const clone = await session.capture(path, `${name}-self`, opts);
			const v = await verify(ref.spec, ref.dir, clone, { fidelity: "pixel" });
			logVerdict(`${name} self`, v);
			expect(v.setupErrors).toEqual([]);
			expect(failingIds(v)).toEqual([]);
			expect(v.rows.length).toBe(ref.spec.rows.length + ref.spec.still.length);
			expect(v.pixel?.meanMismatch).toBe(0);
			expect(v.pixel?.pass).toBe(true);
			expect(v.pass).toBe(true);
			expect(existsSync(join(clone, "verdict.json"))).toBe(true);
			expect(await writeSheets(v, join(clone, "sheets"))).toEqual([]);
			expect(existsSync(join(clone, "sheets"))).toBe(false);
		});
});

describe("wrong variants fail on the right rows", () => {
	const fadeVariant = async (name: string) => {
		const clone = await session.capture(`_variants/${name}`, name, FADE);
		const v = await verify(refs.fade.spec, refs.fade.dir, clone);
		logVerdict(name, v);
		expect(v.setupErrors).toEqual([]);
		expect(v.pass).toBe(false);
		return v;
	};

	it("variants are not listed as fixtures", () => {
		expect(listFixtures().map((f) => f.dir)).not.toContain("_variants");
	});

	it("ease-in instead of easeOutExpo fails every card on easing only", async () => {
		const v = await fadeVariant("fade-ease-in");
		expect(failingIds(v)).toEqual(CARD_ROWS.slice().sort());
		for (const id of CARD_ROWS) {
			const row = v.rows.find((r) => r.id === id);
			expect(row?.metrics.easing?.pass).toBe(false);
			expect(row?.metrics.start?.pass).toBe(true);
			expect(row?.metrics.duration?.pass).toBe(true);
			expect(row?.message).toMatch(
				/^\.card\[\d\] (opacity|translateY) easing too slow at the start: max deviation 0\.\d+ from cubic-bezier\(0\.16, 1, 0\.3, 1\) \(easeOutExpo\); the clone fits cubic-bezier\(0\.42, 0, 1, 1\) \(ease-in\)$/,
			);
		}
		expect(
			v.warnings.filter((w) => w.rule === "ease-in-entrance"),
		).toHaveLength(4);
	});

	it("a 150 ms stagger fails cards 1 to 3", async () => {
		const v = await fadeVariant("fade-stagger-150");
		expect(failingIds(v)).toEqual(CARD_ROWS.slice(2).sort());
		expect(messageOf(v, ".card[1].translateY")).toBe(
			".card[1] translateY starts 150 ms after .card[0].translateY (want a 90 ms stagger gap)",
		);
		expect(messageOf(v, ".card[3].opacity")).toBe(
			".card[3] opacity starts 180 ms late (want 470, got 650)",
		);
	});

	it("item 2 delayed by 120 ms fails item 2 only", async () => {
		const v = await fadeVariant("fade-item2-late");
		expect(failingIds(v)).toEqual([".card[2].opacity", ".card[2].translateY"]);
		expect(messageOf(v, ".card[2].translateY")).toContain(
			".card[2] translateY starts 120 ms late (want 380, got 500)",
		);
	});

	it("an animated title fails its still entry only", async () => {
		const v = await fadeVariant("fade-title-moves");
		expect(failingIds(v)).toEqual(["h1[0]"]);
		expect(messageOf(v, "h1[0]")).toMatch(
			/^h1\[0\] should stay still but moves: opacity 0 -> 1 from \d+ ms/,
		);
		// Rest-frame pixels are reported always and enforced only for pixel fidelity.
		expect(v.pixel?.enforced).toBe(false);
		const strict = await verify(refs.fade.spec, refs.fade.dir, v.cloneDir, {
			fidelity: "pixel",
			pixelThreshold: 0,
			outDir: false,
		});
		expect(strict.pixel?.pass).toBe(false);
	});

	it("an overdamped spring fails the spring row on overshoot, easing and duration", async () => {
		const clone = await session.capture(
			"_variants/spring-overdamped",
			"spring-overdamped",
			SPRING,
		);
		const v = await verify(refs.spring.spec, refs.spring.dir, clone);
		logVerdict("spring-overdamped", v);
		expect(failingIds(v)).toEqual([".box[0].translateX"]);
		const row = v.rows[0];
		expect(row?.metrics.overshoot?.pass).toBe(false);
		expect(row?.metrics.easing?.pass).toBe(false);
		expect(row?.metrics.distance?.pass).toBe(true);
		expect(row?.message).toMatch(
			/\.box\[0\] translateX overshoots 0 % past its end value \(want 1\d(\.\d)? %\)/,
		);
		expect(row?.message).toMatch(/\.box\[0\] translateX runs \d+ ms too long/);
	});
});

describe("setup, report and sheets", () => {
	it("a clone captured at another fps is a setup error, not row results", async () => {
		const clone = await session.capture("css-fade-up-stagger", "fade-fps15", {
			...FADE,
			fps: 15,
		});
		const v = await verify(refs.fade.spec, refs.fade.dir, clone);
		expect(v.setupErrors).toEqual([
			"fps differs: reference 30, clone 15; capture the clone with fps 30",
		]);
		expect(v.rows).toEqual([]);
		expect(v.pass).toBe(false);
		expect(renderReport(v)).toContain("## Setup errors");
		expect(await writeSheets(v, join(clone, "sheets"))).toEqual([]);
	});

	it("writes the markdown report and sheets for failing rows only", async () => {
		const clone = await session.capture(
			"_variants/fade-item2-late",
			"item2-report",
			FADE,
		);
		const v = await verify(refs.fade.spec, refs.fade.dir, clone);
		const md = await writeReport(
			join(clone, "verdict.json"),
			join(clone, "report.md"),
		);
		expect(md).toContain("# motionclone verify: FAIL");
		expect(
			md
				.split("\n")
				.filter((l) => l.startsWith("| .card") || l.startsWith("| h1")),
		).toHaveLength(v.rows.length);
		expect(md).toContain(
			"- .card[2] translateY starts 120 ms late (want 380, got 500)",
		);

		const sheets = await writeSheets(v, join(clone, "sheets"));
		expect(sheets.map((s) => s.id).sort()).toEqual([
			".card[2].opacity",
			".card[2].translateY",
		]);
		const files = (await readdir(join(clone, "sheets"))).sort();
		expect(files).toEqual([
			"card-2-opacity.json",
			"card-2-opacity.png",
			"card-2-translatey.json",
			"card-2-translatey.png",
		]);
		const info = JSON.parse(
			await readFile(join(clone, "sheets", "card-2-opacity.json"), "utf8"),
		);
		const png = PNG.sync.read(
			await readFile(join(clone, "sheets", "card-2-opacity.png")),
		);
		expect(info.tiles.length % 3).toBe(0);
		expect(png.width).toBe(3 * info.tileWidth + 4 * 8);
		// The header (id, message, column titles) and the per-row time labels are drawn, not blank.
		const lit = (x0: number, y0: number, w: number, h: number) => {
			let n = 0;
			for (let y = y0; y < y0 + h; y++)
				for (let x = x0; x < x0 + w; x++)
					if ((png.data[(y * png.width + x) * 4] ?? 0) > 150) n++;
			return n;
		};
		expect(info.headerHeight).toBeGreaterThan(3 * 20);
		expect(lit(0, 0, png.width, info.headerHeight)).toBeGreaterThan(100);
		const rows = info.tiles.length / 3;
		expect(png.height).toBe(
			info.headerHeight + rows * (20 + info.tileHeight + 8),
		);
		expect(info.tiles[0].y).toBe(info.headerHeight + 20);
		expect(lit(8, info.headerHeight, 72, 20)).toBeGreaterThan(20);
		// The failing moment: after the wanted start (380 ms) but before the clone's (500 ms), then after both.
		const times = info.tiles.map((t: { t: number }) => t.t);
		expect(times.some((t: number) => t > 380 && t < 500)).toBe(true);
		expect(Math.max(...times)).toBeGreaterThanOrEqual(500);
	});
});

describe("guardrails", () => {
	it("flags layout properties animated instead of transforms", async () => {
		const clone = await session.capture(
			"_variants/fade-layout-top",
			"layout-top",
			FADE,
		);
		const warnings = await guardrails(clone);
		const layout = warnings.filter((w) => w.rule === "layout-property");
		expect(layout.map((w) => w.target).sort()).toEqual(
			[0, 1, 2, 3].map((i) => `.card[${i}]`),
		);
		expect(layout[0]?.message).toContain(
			"animate translateY instead of top/left/margin",
		);
		const v = await verify(refs.fade.spec, refs.fade.dir, clone, {
			outDir: false,
		});
		expect(messageOf(v, ".card[0].translateY")).toContain(
			"it moves its layout box (y) instead: animate translateY",
		);
	});

	it("flags motion unchanged under prefers-reduced-motion", async () => {
		const reduced = await session.capture(
			"css-fade-up-stagger",
			"fade-reduced",
			{
				...FADE,
				reducedMotion: "reduce",
			},
		);
		const warned = await guardrails(refs.fade.dir, { reducedClone: reduced });
		expect(warned.filter((w) => w.rule === "reduced-motion")).toHaveLength(1);

		const opts = { durationMs: 1200, fps: 30, track: [".card"] };
		const normal = await session.capture("reduced-motion", "rm-normal", opts);
		const handled = await session.capture("reduced-motion", "rm-reduced", {
			...opts,
			reducedMotion: "reduce",
		});
		expect(await guardrails(normal, { reducedClone: handled })).toEqual([]);
	});
});
