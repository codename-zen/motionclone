import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Answer } from "../fixtures/answer-schema.ts";
import { captureMotion } from "../src/capture/index.ts";
import { splitAtRests } from "../src/measure/segments.ts";
import type { Series } from "../src/measure/series.ts";
import { draftSpec } from "../src/spec/draft.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { verify } from "../src/verify/index.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "sheet-loop");
const FPS = 30;
const FRAME_MS = 1000 / FPS;

let root: string;
let answer: Answer;
let ref: string;
let spec: SpecFile;

async function capture(name: string, html: string): Promise<string> {
	const page = join(root, `${name}.html`);
	await writeFile(page, html);
	const out = await captureMotion({
		url: page,
		outDir: join(root, name),
		viewport: answer.viewport,
		durationMs: answer.captureMs,
		fps: FPS,
		track: [".sheet"],
	});
	return out.outDir;
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-multi-"));
	answer = Answer.parse(
		JSON.parse(await readFile(join(FIXTURE, "answer.json"), "utf8")),
	);
	const html = await readFile(join(FIXTURE, "index.html"), "utf8");
	ref = await capture("ref", html);
	spec = await draftSpec(ref, { write: false });
}, 180_000);

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("several motions of one property", () => {
	it("splits a series at rests and keeps a single motion whole", () => {
		const s = (v: (t: number) => number): Series =>
			Array.from({ length: 120 }, (_, k) => [k * FRAME_MS, v(k * FRAME_MS)]);
		const ramp = (t: number, a: number) =>
			Math.min(1, Math.max(0, (t - a) / 300));
		expect(
			splitAtRests(
				s((t) => 100 * ramp(t, 400)),
				0.5,
			),
		).toHaveLength(1);
		const pulse = splitAtRests(
			s((t) => 100 * (ramp(t, 400) - ramp(t, 1800))),
			0.5,
		);
		expect(pulse).toHaveLength(2);
		// Reading wobble after a fade, with still stretches between, is not a second motion.
		const wobble = (t: number) =>
			ramp(t, 400) - (t > 1800 && t < 2000 ? 0.06 : 0) + (t > 2600 ? 0.03 : 0);
		expect(splitAtRests(s(wobble), 0.01)).toHaveLength(1);
		// A hold shorter than a rest stays inside one motion.
		expect(
			splitAtRests(
				s((t) => 100 * (ramp(t, 400) - ramp(t, 800))),
				0.5,
			),
		).toHaveLength(1);
	});

	it("drafts one row per slide of the looping sheet, numbered like progress rows", () => {
		const rows = spec.rows
			.filter((r) => r.property === "translateY")
			.sort((a, b) => a.startMs - b.startMs);
		expect(rows.map((r) => r.id)).toEqual([
			".sheet[0].translateY",
			".sheet[0].translateY#2",
			".sheet[0].translateY#3",
			".sheet[0].translateY#4",
		]);
		rows.forEach((r, i) => {
			const key = answer.rows[i] as Answer["rows"][number];
			expect(Math.abs(r.startMs - key.startMs)).toBeLessThanOrEqual(
				2 * FRAME_MS,
			);
			expect(Math.abs(r.durationMs - key.durationMs)).toBeLessThanOrEqual(40);
			expect(r.from).toBeCloseTo(Number(key.from), 0);
			expect(r.to).toBeCloseTo(Number(key.to), 0);
		});
		expect(spec.dropped).toEqual([]);
	});

	it("passes the same page", async () => {
		const v = await verify(spec, ref, ref, { outDir: false });
		expect(v.rows.filter((r) => !r.pass).map((r) => r.message)).toEqual([]);
		expect(v.status).toBe("pass");
	});

	it("fails a clone with only one cycle on the motion count", async () => {
		const html = (await readFile(join(FIXTURE, "index.html"), "utf8")).replace(
			/,\s*down 300ms cubic-bezier\(0\.33, 1, 0\.68, 1\) 4400ms forwards, up 300ms cubic-bezier\(0\.33, 1, 0\.68, 1\) 6300ms forwards;\s*animation-composition/,
			";\n    animation-composition",
		);
		expect(html).not.toContain("4400ms forwards;\n    animation-composition");
		const clone = await capture("one-cycle", html);
		const v = await verify(spec, ref, clone, { outDir: false });
		const failing = v.rows.filter((r) => !r.pass);
		expect(failing.map((r) => r.id)).toEqual([
			".sheet[0].translateY#3",
			".sheet[0].translateY#4",
		]);
		expect(failing[0]?.message).toBe(
			".sheet[0] translateY has 2 motions, want 4",
		);
		expect(v.pass).toBe(false);
	}, 120_000);
});
