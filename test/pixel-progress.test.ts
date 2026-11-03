import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { readTrack, type Track } from "../src/measure/elements.ts";
import {
	elementRegion,
	measureProgress,
	type Rect,
} from "../src/pixel/measure.ts";
import { readCaptureFile } from "../src/spec/capture-file.ts";
import { draftSpec } from "../src/spec/draft.ts";
import { progressTiming } from "../src/spec/progress-row.ts";
import { verify } from "../src/verify/index.ts";
import { framePath } from "../src/verify/pixels.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import {
	DIM,
	expectTiming,
	FPS,
	failing,
	HEADER,
	linearGap,
	PAGE,
	REVEAL,
	VIEWPORT,
	variantPage,
} from "./progress-helpers.ts";

const OPTS = { fps: FPS, viewport: VIEWPORT, durationMs: 2000 };

let session: CaptureSession;
let tmp: string;

beforeAll(async () => {
	session = await openCaptureSession("pixel-progress");
	tmp = await mkdtemp(join(tmpdir(), "motionclone-pixel-progress-"));
});

afterAll(async () => {
	await session?.close();
	if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("pixel progress with a clip offset and device scale 2", () => {
	// Region x 150..190, y 60..80 in page px is device px 100..180, 20..60; it fades from frame 3 to 6.
	// A square outside it flips at frame 8 and must not count.
	const shade = (k: number, x: number, y: number) => {
		if (x >= 100 && x < 180 && y >= 20 && y < 60)
			return 255 - Math.round(255 * Math.min(1, Math.max(0, (k - 3) / 3)));
		return x >= 300 && y >= 100 && k >= 8 ? 0 : 255;
	};

	it("measures inside the region only, in device pixels", async () => {
		const dir = join(tmp, "synthetic");
		await mkdir(join(dir, "frames"), { recursive: true });
		for (let k = 0; k < 10; k++) {
			const png = new PNG({ width: 400, height: 200 });
			for (let y = 0; y < 200; y++)
				for (let x = 0; x < 400; x++) {
					const p = (y * 400 + x) * 4;
					png.data.fill(shade(k, x, y), p, p + 3);
					png.data[p + 3] = 255;
				}
			await writeFile(framePath(dir, k), PNG.sync.write(png));
		}
		const track: Track = {
			selectors: [],
			frameMs: 20,
			frames: Array.from({ length: 10 }, (_, k) => ({
				frame: k,
				t: k * 20,
				scrollY: 0,
				elements: {},
			})),
		};
		const clip = { x: 100, y: 50, width: 200, height: 100 };
		const [r] = await measureProgress(dir, track, clip, [
			{ x: 150, y: 60, w: 40, h: 20 },
		]);
		expect(r?.windows).toHaveLength(1);
		const w = r?.windows[0];
		expect(w).toMatchObject({ fromFrame: 3, toFrame: 6 });
		expect(w?.blend).toBeLessThan(0.01);
		const p = new Map(w?.series);
		expect(p.get(60)).toBeCloseTo(0, 2);
		expect(p.get(80)).toBeCloseTo(1 / 3, 2);
		expect(p.get(100)).toBeCloseTo(2 / 3, 2);
		expect(p.get(180)).toBeCloseTo(1, 2);
	});
});

describe(`${PAGE}: a page capture`, () => {
	let dir: string;
	let track: Track;

	beforeAll(async () => {
		dir = await session.capture(PAGE, "dom", {
			...OPTS,
			track: [".card", ".dim", ".cover"],
		});
		track = await readTrack(dir);
	}, 120_000);

	it("recovers the cross-fade in the cover's box and the dim in a header region", async () => {
		const cover = elementRegion(track, ".cover", 0) as Rect;
		const { clip } = await readCaptureFile(dir);
		const [c, h] = await measureProgress(dir, track, clip, [cover, HEADER]);
		const reveal = progressTiming(
			c?.windows.find((w) => w.toMs > 1400)?.series ?? [],
		);
		const dim = progressTiming(h?.windows[0]?.series ?? []);
		if (!reveal || !dim) throw new Error("no change measured");
		console.log("page reveal", reveal.startMs, reveal.durationMs);
		console.log("page dim", dim.startMs, dim.durationMs);
		expectTiming(reveal, REVEAL);
		expect(linearGap(reveal.easing)).toBeLessThanOrEqual(0.05);
		expectTiming(dim, DIM);
	});

	it("drafts no progress row when tracked rows explain every change", async () => {
		const spec = await draftSpec(dir, { write: false });
		expect(spec.rows.filter((r) => r.property === "progress")).toEqual([]);
	});
});

describe(`${PAGE}: a page reference that does not track the cover`, () => {
	const opts = { ...OPTS, track: [".card", ".dim"] };
	let ref: string;
	let spec: Awaited<ReturnType<typeof draftSpec>>;

	beforeAll(async () => {
		ref = await session.capture(PAGE, "ref-untracked-cover", opts);
		spec = await draftSpec(ref, { write: false });
	}, 120_000);

	it("drafts one progress row, for the cross-fade inside the card", () => {
		const progress = spec.rows.filter((r) => r.property === "progress");
		expect(progress.map((r) => r.id)).toEqual([".card[0].progress"]);
		expectTiming(progress[0] as (typeof progress)[0], REVEAL);
	});

	it("passes a second capture and fails one whose reveal starts 120 ms late", async () => {
		const same = await session.capture(PAGE, "same-untracked-cover", opts);
		const ok = await verify(spec, ref, same, { outDir: false });
		expect(failing(ok).map((r) => r.message)).toEqual([]);
		expect(ok.pass).toBe(true);
		const late = await captureMotion({
			...opts,
			url: await variantPage(tmp, "late"),
			outDir: join(tmp, "late-untracked-cover"),
		});
		const v = await verify(spec, ref, late.outDir, { outDir: false });
		const row = v.rows.find((r) => r.id === ".card[0].progress");
		console.log(row?.message);
		expect(row?.pass).toBe(false);
		expect(row?.message).toContain(".card[0] progress starts");
		expect(failing(v).map((r) => r.id)).toEqual([".card[0].progress"]);
	}, 120_000);
});
