import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Answer } from "../fixtures/answer-schema.ts";
import { curveRange } from "../src/fit/plausible.ts";
import { readTrack } from "../src/measure/elements.ts";
import { renderReport } from "../src/report/report.ts";
import { draftSpec } from "../src/spec/draft.ts";
import { unitCurve } from "../src/spec/easing.ts";
import type { SpecFile, SpecRow } from "../src/spec/schema.ts";
import { verify } from "../src/verify/index.ts";
import type { Verdict } from "../src/verify/schema.ts";
import { captureVideo } from "../src/video/index.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import { type StaticServer, serveRepo } from "./serve.ts";
import {
	answerEasing,
	answerOf,
	encodeFrames,
	padded,
	sweep,
	X264,
} from "./video-helpers.ts";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");
const FPS = 60;
const NOTCH = { durationMs: 1200, fps: FPS, track: [".art", ".title"] };
const DECLARED_BLUR = 24;
const SHAPES = ["blur", "scale"];

const failingIds = (v: Verdict) =>
	v.rows
		.filter((r) => !r.pass && r.advisory === null)
		.map((r) => r.id)
		.sort();

function logVerdict(name: string, v: Verdict) {
	console.log(
		`${name}: ${v.summary.passed}/${v.summary.rows - v.summary.advisory} pass, ${v.summary.advisory} advisory\n${v.rows
			.filter((r) => !r.pass || r.advisory !== null)
			.map(
				(r) =>
					`  ${r.advisory === null ? "" : `[advisory: ${r.advisory}] `}${r.pass ? "matches" : r.message}`,
			)
			.join("\n")}`,
	);
}

const logRows = (name: string, spec: SpecFile) => {
	for (const r of spec.rows)
		console.log(
			`${name} ${r.id}: ${r.from} -> ${r.to}${r.fromObserved ? "" : " (start not seen)"}, start ${r.startMs}, duration ${r.durationMs}, ${JSON.stringify(r.easing.type === "cubic-bezier" ? r.easing.p : r.easing.type)}, ${r.confidence} ${JSON.stringify(r.support)}`,
		);
};

/** Problems that make a drafted row impossible, empty when it is plausible. */
function implausible(r: SpecRow): string[] {
	const out: string[] = [];
	const values = [r.from, r.to];
	if (r.property === "opacity") {
		if (values.some((v) => v < 0 || v > 1)) out.push("opacity outside [0, 1]");
		const [lo, hi] = curveRange(unitCurve(r.easing));
		const implied = [lo, hi].map((p) => r.from + (r.to - r.from) * p);
		if (implied.some((v) => v < -0.02 || v > 1.02))
			out.push(`curve takes opacity to ${implied.map((v) => v.toFixed(3))}`);
	}
	if (r.property.startsWith("scale") && values.some((v) => v <= 0.3))
		out.push("scale at or under 0.3");
	if (
		r.property === "blur" &&
		values.some((v) => v < 0 || v > 2 * DECLARED_BLUR)
	)
		out.push(`blur outside [0, ${2 * DECLARED_BLUR}] px`);
	if (r.easing.type === "cubic-bezier") {
		const [x1, y1, x2, y2] = r.easing.p;
		if ([x1, x2].some((x) => x < 0 || x > 1))
			out.push("control point x outside [0, 1]");
		if ([y1, y2].some((y) => y < -1 || y > 2))
			out.push("control point y outside [-1, 2]");
	}
	return out;
}

let session: CaptureSession;
let server: StaticServer;
let tmp: string;
let domDir: string;
let domSpec: SpecFile;
let answer: Answer;

beforeAll(async () => {
	tmp = await mkdtemp(join(tmpdir(), "motionclone notch-"));
	session = await openCaptureSession("notch");
	server = await serveRepo();
	domDir = await session.capture("notch-expand", "dom", NOTCH);
	domSpec = await draftSpec(domDir, { write: false });
	answer = await answerOf("notch-expand");
}, 120_000);

afterAll(async () => {
	await session?.close();
	await server?.close();
	if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("notch-expand from a page capture", () => {
	it("drafts the answer key: declared starts, durations and easings for art and title", () => {
		logRows("dom", domSpec);
		expect(domSpec.rows.map((r) => r.id).sort()).toEqual(
			answer.rows.map((k) => `${k.selector}[0].${k.property}`).sort(),
		);
		for (const key of answer.rows) {
			const row = domSpec.rows.find(
				(r) => r.selector === key.selector && r.property === key.property,
			);
			expect(row?.source).toBe("declared");
			expect(row?.confidence).toBe("high");
			expect(row?.startMs).toBe(key.startMs);
			expect(row?.durationMs).toBe(key.durationMs);
			expect(row?.easing).toEqual(answerEasing(key));
			expect(row?.from).toBeCloseTo(Number(key.from), 3);
			expect(row?.to).toBeCloseTo(Number(key.to), 3);
		}
	});

	it("passes a second capture of the page with no failing or advisory rows", async () => {
		const clone = await session.capture("notch-expand", "dom-self", NOTCH);
		const v = await verify(domSpec, domDir, clone, { outDir: false });
		logVerdict("dom self", v);
		expect(v.setupErrors).toEqual([]);
		expect(failingIds(v)).toEqual([]);
		expect(v.summary.failed).toBe(0);
		expect(v.summary.advisory).toBe(0);
		expect(v.pass).toBe(true);
	});

	it("fails exactly the blur and scale rows when the rebuild leaves them out", async () => {
		const clone = await session.capture(
			"_variants/notch-no-blur-scale",
			"dom-variant",
			NOTCH,
		);
		const v = await verify(domSpec, domDir, clone, { outDir: false });
		logVerdict("dom variant", v);
		expect(failingIds(v)).toEqual(
			[".art[0]", ".title[0]"].flatMap((e) => SHAPES.map((p) => `${e}.${p}`)),
		);
		expect(v.pass).toBe(false);
	});

	it("reports low-confidence rows as advisory: listed as differing, never failing", async () => {
		const spec = structuredClone(domSpec);
		for (const r of spec.rows)
			if (SHAPES.includes(r.property)) {
				r.confidence = "low";
				r.support = {
					samples: 2,
					rmse: 0.2,
					observed: 1,
					quality: null,
					weak: ["2 reliable samples in the motion"],
				};
			}
		const clone = await session.capture(
			"_variants/notch-no-blur-scale",
			"dom-advisory",
			NOTCH,
		);
		const v = await verify(spec, domDir, clone, { outDir: false });
		expect(v.summary).toEqual({ rows: 8, passed: 4, failed: 0, advisory: 4 });
		expect(v.pass).toBe(true);
		const md = renderReport(v);
		expect(md.split("\n")[0]).toMatch(
			/^# motionclone verify: PASS \(4 rows checked, 4 advisory\)/,
		);
		expect(md).toContain("## Advisory (low confidence)");
		expect(md).toContain("| .art[0].blur | differs |");
		expect(md).toContain(
			"- .art[0].blur: evidence is weak: 2 reliable samples in the motion. Differs: .art[0] blur missing",
		);
		expect(md).not.toContain("## Fix");
	});
});

describe("notch-expand from a video", () => {
	let refDir: string;
	let spec: SpecFile;

	const cli = async (...args: string[]) => {
		try {
			return {
				code: 0,
				...(await run(process.execPath, [CLI, ...args], {
					cwd: ROOT,
					timeout: 180_000,
				})),
			};
		} catch (e) {
			const err = e as { code: number; stdout: string; stderr: string };
			return { code: err.code, stdout: err.stdout, stderr: err.stderr };
		}
	};

	const cloneAndVerify = async (name: string, path: string) => {
		const out = join(tmp, name);
		const clone = await cli(
			"capture",
			`${server.url}/fixtures/${path}/index.html`,
			"--like",
			refDir,
			"--track",
			".art,.title",
			"--out",
			out,
		);
		expect(clone.code).toBe(0);
		const v = await verify(spec, refDir, out, {
			map: ["art=.art", "title=.title"],
			outDir: false,
		});
		expect(v.setupErrors).toEqual([]);
		logVerdict(name, v);
		return v;
	};

	beforeAll(async () => {
		const mp4 = join(tmp, "notch.mp4");
		await encodeFrames(domDir, mp4, FPS, X264);
		const track = await readTrack(domDir);
		const summary = await captureVideo({
			input: mp4,
			outDir: join(tmp, "ref"),
			regions: [
				{ name: "art", ...padded(sweep(track, ".art"), 6) },
				{ name: "title", ...padded(sweep(track, ".title"), 6) },
			],
		});
		refDir = summary.outDir;
		spec = await draftSpec(refDir);
		logRows("video", spec);
	}, 240_000);

	it("drafts no implausible values", () => {
		const bad = spec.rows
			.map((r) => ({ id: r.id, problems: implausible(r) }))
			.filter((r) => r.problems.length > 0);
		expect(bad).toEqual([]);
	});

	it("passes a DOM --like clone, listing advisory rows apart", async () => {
		const v = await cloneAndVerify("clone", "notch-expand");
		expect(failingIds(v)).toEqual([]);
		expect(v.pass).toBe(true);
		const md = renderReport(v);
		const advisory = v.rows.filter((r) => r.advisory !== null);
		if (advisory.length > 0) {
			expect(md.split("\n")[0]).toContain(
				`(${v.summary.rows - advisory.length} rows checked, ${advisory.length} advisory)`,
			);
			expect(md).toContain("## Advisory (low confidence)");
			for (const r of advisory)
				expect(md).toContain(`- ${r.id}: evidence is weak: ${r.advisory}`);
		}
	});

	// Shape rows drafted with low confidence are advisory: they cannot fail, but the report must show them differing.
	// A video row y is the top of the scaled box (ADR 0002), so a rebuild without scale also moves its box y differently.
	it("the rebuild without blur and scale fails those rows, or shows them differing as advisory", async () => {
		const ids = ["art[0]", "title[0]"].flatMap((e) =>
			SHAPES.map((p) => `${e}.${p}`),
		);
		expect(spec.rows.map((r) => r.id)).toEqual(expect.arrayContaining(ids));
		const v = await cloneAndVerify("variant", "_variants/notch-no-blur-scale");
		const md = renderReport(v);
		for (const id of ids) {
			const r = v.rows.find((x) => x.id === id);
			expect(r?.pass).toBe(false);
			if (r?.advisory !== null) expect(md).toContain(`| ${id} | differs |`);
		}
		const boxY = ["art[0].y", "title[0].y"];
		expect(
			failingIds(v).filter((id) => !ids.includes(id) && !boxY.includes(id)),
		).toEqual([]);
		const checked = ids.filter(
			(id) => v.rows.find((r) => r.id === id)?.advisory === null,
		);
		expect(v.pass).toBe(checked.length === 0);
	});
});
