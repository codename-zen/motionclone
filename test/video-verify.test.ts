import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTrack } from "../src/measure/elements.ts";
import type { Verdict } from "../src/verify/schema.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import { type StaticServer, serveRepo } from "./serve.ts";
import { boxAt, encodeFrames, padded, X264 } from "./video-helpers.ts";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");
const FPS = 60;

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

async function motionclone(...args: string[]): Promise<Result> {
	try {
		const r = await run(process.execPath, [CLI, ...args], {
			cwd: ROOT,
			timeout: 180_000,
		});
		return { code: 0, ...r };
	} catch (e) {
		const err = e as { code: number; stdout: string; stderr: string };
		return { code: err.code, stdout: err.stdout, stderr: err.stderr };
	}
}

describe("video reference against a DOM clone", () => {
	let session: CaptureSession;
	let server: StaticServer;
	let tmp: string;
	let mp4: string;
	let refDir: string;
	const dir = (n: string) => join(tmp, n);
	const page = (path: string) => `${server.url}/fixtures/${path}/index.html`;

	const cloneAndVerify = async (name: string, path: string) => {
		const clone = await motionclone(
			"capture",
			page(path),
			"--like",
			refDir,
			"--track",
			".card",
			"--out",
			dir(name),
		);
		expect(clone.stderr).toBe("");
		expect(clone.code).toBe(0);
		const v = await motionclone(
			"verify",
			refDir,
			dir(name),
			"--map",
			"card=.card",
			"--json",
		);
		return { v, verdict: JSON.parse(v.stdout) as Verdict };
	};

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-verify-"));
		session = await openCaptureSession("video-verify");
		server = await serveRepo();
		const fade = await session.capture("css-fade-up-stagger", "fade", {
			durationMs: 1500,
			fps: FPS,
			track: [".card"],
		});
		mp4 = dir("fade.mp4");
		await encodeFrames(fade, mp4, FPS, X264);
		const last = (await readTrack(fade)).frames.at(-1);
		const regions = [0, 1, 2, 3].flatMap((i) => {
			const b = padded(boxAt(last, ".card", i), 6);
			return ["--region", `card[${i}]=${b.x},${b.y},${b.w},${b.h}`];
		});
		const cap = await motionclone(
			"capture",
			mp4,
			"--out",
			dir("ref"),
			...regions,
		);
		expect(cap.stderr).toBe("");
		expect(cap.code).toBe(0);
		refDir = dir("ref");
		const spec = await motionclone("spec", refDir);
		expect(spec.code).toBe(0);
	}, 240_000);

	afterAll(async () => {
		await session?.close();
		await server?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	it("links the indexed regions as one group", async () => {
		const spec = JSON.parse(await readFile(join(refDir, "spec.json"), "utf8"));
		const y = spec.rows.filter((r: { id: string }) =>
			/^card\[\d\]\.y$/.test(r.id),
		);
		expect(y).toHaveLength(4);
		expect(y[2].stagger).toMatchObject({ after: "card[1].y" });
	});

	it("matches a clone of the same page: all rows pass", async () => {
		const { v, verdict } = await cloneAndVerify("clone", "css-fade-up-stagger");
		expect(verdict.setupErrors).toEqual([]);
		expect(verdict.summary.rows).toBeGreaterThanOrEqual(8);
		const failing = verdict.rows.filter((r) => !r.pass).map((r) => r.message);
		expect(failing).toEqual([]);
		expect(v.code).toBe(0);
	});

	it("fails exactly on card[2] when the third card starts 120 ms late", async () => {
		const { v, verdict } = await cloneAndVerify(
			"late",
			"_variants/fade-item2-late",
		);
		const failing = verdict.rows.filter((r) => !r.pass);
		expect(failing.length).toBeGreaterThan(0);
		for (const r of failing) expect(r.id).toMatch(/^card\[2\]\./);
		expect(failing.map((r) => r.message).join(" ")).toContain("card[2]");
		expect(v.code).toBe(1);
	});

	it("explains a clone captured at another frame rate", async () => {
		const bad = await motionclone(
			"capture",
			page("css-fade-up-stagger"),
			"--duration",
			"1500",
			"--fps",
			"30",
			"--track",
			".card",
			"--out",
			dir("fps30"),
		);
		expect(bad.code).toBe(0);
		const v = await motionclone(
			"verify",
			refDir,
			dir("fps30"),
			"--map",
			"card=.card",
		);
		expect(v.code).toBe(2);
		expect(v.stdout).toContain("fps differs");
	});

	it("probes a video and rejects a bad region string", async () => {
		const probe = await motionclone("probe", mp4);
		expect(probe.code).toBe(0);
		expect(probe.stdout).toContain("size: 1280x800");
		expect(probe.stdout).toContain("fps: 60");
		expect(probe.stdout).toContain("codec: h264");
		const bad = await motionclone(
			"capture",
			mp4,
			"--out",
			dir("bad"),
			"--region",
			"card[0]=1,2,3",
		);
		expect(bad.code).toBe(2);
		expect(bad.stderr).toContain("--region");
		const noName = await motionclone(
			"capture",
			mp4,
			"--out",
			dir("bad2"),
			"--region",
			"1,2,3,4",
		);
		expect(noName.code).toBe(2);
		expect(noName.stderr).toContain("name=x,y,w,h");
		const missing = await motionclone("probe", dir("nope.mp4"));
		expect(missing.code).toBe(2);
	});
});
