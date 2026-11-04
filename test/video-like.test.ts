import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureLines } from "../src/cli/capture-run.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import { type StaticServer, serveRepo } from "./serve.ts";
import { encodeFrames, frameFile, readPng, X264 } from "./video-helpers.ts";

const FPS = 30;
// A 2x recording of a 640x400 page, cropped to the top-left 800x600 video pixels: 400x300 CSS pixels.
const CROP = "0,0,800,600";

describe("capture --like on a cropped 2x recording", () => {
	let session: CaptureSession;
	let server: StaticServer;
	let tmp: string;
	const dir = (n: string) => join(tmp, n);
	const json = async (d: string) =>
		JSON.parse(await readFile(join(d, "capture.json"), "utf8"));
	const page = () => `${server.url}/fixtures/css-fade-up-stagger/index.html`;

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-like-"));
		session = await openCaptureSession("video-like");
		server = await serveRepo();
		const dom = await session.capture("css-fade-up-stagger", "dom", {
			durationMs: 600,
			fps: FPS,
			viewport: { width: 640, height: 400 },
			deviceScaleFactor: 2,
		});
		await encodeFrames(dom, dir("rec.mp4"), FPS, X264);
		await captureLines({
			url: dir("rec.mp4"),
			out: dir("ref"),
			crop: CROP,
			cssScale: 2,
			regions: ["card=40,40,200,200"],
		});
		await captureLines({ url: page(), out: dir("clone"), like: dir("ref") });
		await captureLines({
			url: page(),
			out: dir("wide"),
			like: dir("ref"),
			viewport: "500x320",
		});
	}, 240_000);

	afterAll(async () => {
		await session?.close();
		await server?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	it("takes the viewport and scale from the crop and css-scale", async () => {
		const c = await json(dir("clone"));
		expect(c.options.viewport).toEqual({ width: 400, height: 300 });
		expect(c.options.deviceScaleFactor).toBe(2);
		expect(c.options.fps).toBe(FPS);
		expect(c.options.trigger).toEqual({ type: "load" });
		expect(c.options.likeVideo).toMatchObject({
			crop: { w: 800, h: 600 },
			cssScale: 2,
			scale: 1,
			frameSize: { width: 800, height: 600 },
			viewport: { width: 400, height: 300 },
			deviceScaleFactor: 2,
		});
	});

	it("writes frames of the reference frames' pixel size", async () => {
		const ref = await readPng(frameFile(dir("ref"), 0));
		const clone = await readPng(frameFile(dir("clone"), 0));
		expect([ref.width, ref.height]).toEqual([800, 600]);
		expect([clone.width, clone.height]).toEqual([ref.width, ref.height]);
	});

	it("lets an explicit viewport override the derived one", async () => {
		const c = await json(dir("wide"));
		expect(c.options.viewport).toEqual({ width: 500, height: 320 });
		expect(c.options.deviceScaleFactor).toBe(2);
	});
});
