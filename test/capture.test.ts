import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Answer } from "../fixtures/answer-schema.ts";
import {
	type AnimationRecord,
	type CaptureInput,
	captureMotion,
	type TrackFrame,
	toUrl,
} from "../src/capture/index.ts";
import { type StaticServer, serveRepo } from "./serve.ts";

let server: StaticServer;
let root: string;

beforeAll(async () => {
	server = await serveRepo();
	root = await mkdtemp(join(tmpdir(), "motionclone-capture-"));
});

afterAll(async () => {
	await server?.close();
	if (root) await rm(root, { recursive: true, force: true });
});

const readJson = async <T>(dir: string, file: string): Promise<T> =>
	JSON.parse(await readFile(join(dir, file), "utf8")) as T;

async function frameHashes(dir: string): Promise<string[]> {
	const names = (await readdir(join(dir, "frames"))).sort();
	return Promise.all(
		names.map(async (n) =>
			createHash("sha256")
				.update(await readFile(join(dir, "frames", n)))
				.digest("hex"),
		),
	);
}

function smoke(name: string, extra: Partial<CaptureInput> = {}): CaptureInput {
	return {
		url: `${server.url}/fixtures/_smoke/index.html`,
		outDir: join(root, name),
		durationMs: 1000,
		fps: 30,
		track: [".item"],
		...extra,
	};
}

const EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

describe("captureMotion on _smoke", () => {
	it("answer key validates", async () => {
		const answer = Answer.parse(
			JSON.parse(await readFile("fixtures/_smoke/answer.json", "utf8")),
		);
		expect(answer.rows).toHaveLength(8);
	});

	it("records the keyframe animations and tracks every item", async () => {
		const summary = await captureMotion(smoke("load-a"));
		const dir = summary.outDir;
		expect(summary.frames).toBe(31);
		expect(summary.stack).toContain("css-animation");

		const { animations } = await readJson<{ animations: AnimationRecord[] }>(
			dir,
			"animations.json",
		);
		const rise = animations.filter(
			(a) => a.type === "CSSAnimation" && a.name === "rise",
		);
		expect(rise).toHaveLength(4);
		expect(rise.map((a) => a.delay).sort((x, y) => x - y)).toEqual([
			100, 180, 260, 340,
		]);
		for (const a of rise) {
			expect(a.duration).toBe(600);
			expect(a.startMs).toBe(0);
			expect(a.sources).toEqual(["cdp", "page"]);
			expect(a.keyframes.map((k) => k.offset)).toEqual([0, 1]);
			expect(a.keyframes[0]?.easing).toBe(EASING);
		}
		const byIndex = [...rise].sort((x, y) => x.delay - y.delay);
		expect(byIndex.map((a) => a.tracked)).toEqual(
			[0, 1, 2, 3].map((index) => [{ selector: ".item", index }]),
		);
		expect(new Set(rise.map((a) => a.nodePath)).size).toBe(4);
		expect(byIndex[1]?.nodePath).toBe(
			"html > body:nth-child(2) > div:nth-child(1) > div:nth-child(2)",
		);

		const { frames } = await readJson<{ frames: TrackFrame[] }>(
			dir,
			"track.json",
		);
		expect(frames).toHaveLength(31);
		for (const f of frames)
			expect(f.elements[".item"]?.map((e) => e.index)).toEqual([0, 1, 2, 3]);
		expect(frames[0]?.elements[".item"]?.[0]?.opacity).toBe(0);
		const late = frames.filter((f) => f.t >= 700);
		expect(late.length).toBeGreaterThan(0);
		for (const f of late) expect(f.elements[".item"]?.[0]?.opacity).toBe(1);
		const mid =
			frames.find((f) => f.t === 400)?.elements[".item"]?.[0]?.opacity ?? 0;
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(1);

		const capture = await readJson<{
			versions: Record<string, string>;
			warnings: string[];
		}>(dir, "capture.json");
		expect(Object.keys(capture.versions).sort()).toEqual([
			"browser",
			"node",
			"playwright",
		]);
		expect(capture.warnings).toEqual([]);
	});

	it("is deterministic: frames and track are identical across captures", async () => {
		const b = await captureMotion(smoke("load-b"));
		const a = join(root, "load-a");
		const [ha, hb] = await Promise.all([frameHashes(a), frameHashes(b.outDir)]);
		expect(hb).toHaveLength(31);
		const differing = ha.flatMap((h, i) => (h === hb[i] ? [] : [i]));
		expect(differing).toEqual([]);
		expect(await readFile(join(b.outDir, "track.json"), "utf8")).toBe(
			await readFile(join(a, "track.json"), "utf8"),
		);
	});

	it("keeps the hover transition after it finished", async () => {
		const summary = await captureMotion(
			smoke("hover", {
				trigger: { type: "hover", target: ".hover" },
				track: [".hover"],
				durationMs: 400,
			}),
		);
		const { animations } = await readJson<{ animations: AnimationRecord[] }>(
			summary.outDir,
			"animations.json",
		);
		const tr = animations.filter((a) => a.type === "CSSTransition");
		expect(tr).toHaveLength(1);
		expect(tr[0]).toMatchObject({
			name: "background-color",
			duration: 200,
			delay: 0,
			easing: "ease-out",
			startMs: 0,
		});
		expect(tr[0]?.target).toBe("div.hover");
		expect(summary.stack).toEqual(
			expect.arrayContaining(["css-animation", "css-transition"]),
		);

		const { frames } = await readJson<{ frames: TrackFrame[] }>(
			summary.outDir,
			"track.json",
		);
		const bg = (t: number) =>
			frames.find((f) => f.t === t)?.elements[".hover"]?.[0]?.backgroundColor;
		expect(frames[0]?.t).toBe(-200);
		expect(bg(-200)).toBe("rgb(210, 210, 215)");
		expect(bg(400)).toBe("rgb(47, 111, 237)");
	});
});

describe("captureMotion first frame", () => {
	// GSAP from() renders lazily on its first ticker tick; a real browser runs that before its first paint.
	it("shows GSAP's from-state at t=0 on load", async () => {
		const summary = await captureMotion({
			url: `${server.url}/fixtures/gsap-timeline/index.html`,
			outDir: join(root, "gsap"),
			durationMs: 1200,
			fps: 30,
			track: [".item"],
		});
		const { frames } = await readJson<{ frames: TrackFrame[] }>(
			summary.outDir,
			"track.json",
		);
		const first = frames[0];
		expect(first?.t).toBe(0);
		expect(first?.elements[".item"]?.map((e) => e.opacity)).toEqual([0, 0, 0]);
		const last = frames.at(-1)?.elements[".item"];
		expect(last?.map((e) => e.opacity)).toEqual([1, 1, 1]);
		const hashes = await frameHashes(summary.outDir);
		expect(hashes[0]).not.toBe(hashes.at(-1));
	});
});

describe("toUrl", () => {
	it("converts a Windows path to a file URL", () => {
		expect(toUrl("C:\\x\\my page\\index.html")).toBe(
			"file:///C:/x/my%20page/index.html",
		);
		expect(toUrl("D:/site/index.html")).toBe("file:///D:/site/index.html");
	});

	it("passes URLs through", () => {
		expect(toUrl("https://example.com/a?b=1")).toBe(
			"https://example.com/a?b=1",
		);
		expect(toUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/");
		expect(toUrl("file:///C:/x/index.html")).toBe("file:///C:/x/index.html");
	});
});
