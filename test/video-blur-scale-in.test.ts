import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrackedElement } from "../src/capture/types.ts";
import { bezierY } from "../src/fit/bezier.ts";
import { readTrack, type Track } from "../src/measure/elements.ts";
import { type Property, readProperty } from "../src/measure/series.ts";
import { draftSpec } from "../src/spec/draft.ts";
import { unitCurve } from "../src/spec/easing.ts";
import type { SpecFile } from "../src/spec/schema.ts";
import { PARTIAL_NOTE } from "../src/verify/evidence.ts";
import type { Verdict } from "../src/verify/schema.ts";
import { captureVideo } from "../src/video/index.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import { type StaticServer, serveRepo } from "./serve.ts";
import { maxDeviation } from "./synth.ts";
import {
	boxAt,
	encodeFrames,
	padded,
	rowOf,
	timed,
	X264,
} from "./video-helpers.ts";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");
const FPS = 60;
const FRAME_MS = 1000 / FPS;
const FIXTURE = "css-blur-scale-in";
const EASE = [0.22, 1, 0.36, 1] as const;
const PROPS = ["blur", "opacity", "scale"];

async function motionclone(...args: string[]) {
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
}

describe("video input: cards that fade in, scale and unblur together", () => {
	let session: CaptureSession;
	let server: StaticServer;
	let tmp: string;
	let dom: Track;
	let domSpec: SpecFile;
	let video: Track;
	let refDir: string;

	const cloneOf = async (name: string, url: string) => {
		const clone = await motionclone(
			"capture",
			url,
			"--like",
			refDir,
			"--track",
			".card",
			"--out",
			join(tmp, name),
		);
		expect(clone.code).toBe(0);
		const v = await motionclone(
			"verify",
			refDir,
			join(tmp, name),
			"--map",
			"card=.card",
			"--json",
		);
		const verdict = JSON.parse(v.stdout) as Verdict;
		expect(verdict.setupErrors).toEqual([]);
		for (const r of verdict.rows)
			console.log(
				`${name} ${r.pass ? "pass" : "FAIL"} ${r.id}: evidence ${JSON.stringify(r.metrics.evidence ?? null)} ${r.pass ? "" : r.message}`,
			);
		return verdict;
	};

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-bsi-"));
		session = await openCaptureSession("video-bsi");
		server = await serveRepo();
		const domDir = await session.capture(FIXTURE, "dom", {
			durationMs: 1200,
			fps: FPS,
			track: [".card"],
		});
		dom = await readTrack(domDir);
		domSpec = await draftSpec(domDir, { write: false });
		await encodeFrames(domDir, join(tmp, "cards.mp4"), FPS, X264);
		const last = dom.frames.at(-1);
		const summary = await captureVideo({
			input: join(tmp, "cards.mp4"),
			outDir: join(tmp, "ref"),
			regions: [0, 1, 2].map((i) => ({
				name: `card[${i}]`,
				...padded(boxAt(last, ".card", i), 6),
			})),
		});
		refDir = summary.outDir;
		video = await readTrack(refDir);
		const spec = await motionclone("spec", refDir);
		expect(spec.code).toBe(0);
	}, 240_000);

	afterAll(async () => {
		await session?.close();
		await server?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	const value = (t: Track, sel: string, i: number, k: number, p: Property) =>
		readProperty(t.frames[k]?.elements[sel]?.[i] as TrackedElement, p);

	it("measures opacity, scale and blur on every clearly visible frame", () => {
		for (const i of [0, 1, 2]) {
			const worst = { opacity: 0, scale: 0, blur: 0 };
			for (let k = 0; k < dom.frames.length; k++) {
				if (value(dom, ".card", i, k, "opacity") < 0.3) continue;
				for (const p of ["opacity", "scale", "blur"] as const)
					worst[p] = Math.max(
						worst[p],
						Math.abs(
							value(video, "card", i, k, p) - value(dom, ".card", i, k, p),
						),
					);
			}
			console.log(`card[${i}] worst error once opacity >= 0.3`, worst);
			expect(worst.opacity).toBeLessThanOrEqual(0.1);
			expect(worst.scale).toBeLessThanOrEqual(0.01);
			expect(worst.blur).toBeLessThanOrEqual(1.5);
			const rest = video.frames.at(-1)?.elements.card?.[i];
			expect(rest?.transform).toBe("none");
			expect(rest?.filter).toBe("none");
		}
	});

	// Duration and curve shape are logged, not asserted: the readings cannot tell fast ease-out curves apart (ADR 0003).
	it("drafts rows whose start is not visible, one timing per card, starting within 2 frames of the page", async () => {
		const spec = JSON.parse(
			await readFile(join(refDir, "spec.json"), "utf8"),
		) as SpecFile;
		expect(spec.rows.map((r) => r.id).sort()).toEqual(
			[0, 1, 2].flatMap((i) => PROPS.map((p) => `card[${i}].${p}`)),
		);
		for (const i of [0, 1, 2]) {
			const want = rowOf(domSpec, `.card[${i}].opacity`);
			const rows = PROPS.map((p) => rowOf(spec, `card[${i}].${p}`));
			for (const r of rows) {
				const curve = unitCurve(r.easing);
				const shape = maxDeviation(
					(k) => curve(k / 1000),
					(k) => bezierY(EASE, k / 1000),
					0,
					1000,
				);
				const seenFrom = Number(/from (\d+) ms/.exec(r.notes[0] ?? "")?.[1]);
				const seen = maxDeviation(
					timed(r.easing, r.startMs, r.durationMs),
					timed(want.easing, want.startMs, want.durationMs),
					seenFrom,
					want.startMs + want.durationMs,
				);
				console.log(
					`${r.id}: ${r.from} -> ${r.to}, start ${r.startMs} (page ${want.startMs}), duration ${r.durationMs} (page ${want.durationMs}), ${JSON.stringify(r.easing.type === "cubic-bezier" ? r.easing.p : r.easing.type)}, curve shape dev ${shape.toFixed(3)}, timed dev from ${seenFrom} ms ${seen.toFixed(3)}`,
				);
				expect(r.fromObserved).toBe(false);
				expect(r.notes[0]).toContain("start value not visible");
				expect(Math.abs(r.startMs - want.startMs)).toBeLessThanOrEqual(
					2 * FRAME_MS,
				);
				expect(r.startMs).toBe(rows[0]?.startMs);
				expect(r.durationMs).toBe(rows[0]?.durationMs);
				expect(r.easing).toEqual(rows[0]?.easing);
			}
		}
	});

	it("passes a DOM clone of the same page on every row, checking partly observed rows on the visible readings", async () => {
		const verdict = await cloneOf(
			"clone",
			`${server.url}/fixtures/${FIXTURE}/index.html`,
		);
		expect(verdict.rows.filter((r) => !r.pass).map((r) => r.message)).toEqual(
			[],
		);
		expect(verdict.rows).toHaveLength(9);
		for (const r of verdict.rows) {
			expect(r.notes).toEqual([PARTIAL_NOTE]);
			expect(r.metrics.evidence?.pass).toBe(true);
			expect(r.metrics.start?.pass).toBe(true);
		}
		expect(verdict.pass).toBe(true);
	});

	it("fails the scale and blur rows of every card when the clone only fades", async () => {
		const verdict = await cloneOf(
			"missing",
			`${server.url}/fixtures/_variants/blur-scale-missing/index.html`,
		);
		expect(
			verdict.rows
				.filter((r) => !r.pass)
				.map((r) => r.id)
				.sort(),
		).toEqual(
			[0, 1, 2].flatMap((i) => ["blur", "scale"].map((p) => `card[${i}].${p}`)),
		);
	});

	it("fails every row when the clone eases in", async () => {
		const html = await readFile(
			join(ROOT, "fixtures", FIXTURE, "index.html"),
			"utf8",
		);
		const page = join(tmp, "ease-in.html");
		await writeFile(
			page,
			html.replace("cubic-bezier(0.22,1,0.36,1)", "ease-in"),
		);
		const verdict = await cloneOf("ease-in", page);
		expect(verdict.rows).toHaveLength(9);
		for (const r of verdict.rows) {
			expect(r.pass).toBe(false);
			expect(r.metrics.evidence?.pass).toBe(false);
		}
	});
});
