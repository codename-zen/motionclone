import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import type { TrackedElement } from "../src/capture/types.ts";
import { readTrack, type Track } from "../src/measure/elements.ts";
import { decompose } from "../src/measure/series.ts";
import { draftSpec } from "../src/spec/draft.ts";
import { bezierEasing } from "../src/spec/easing.ts";
import { captureVideo } from "../src/video/index.ts";
import type { RegionTrack } from "../src/video/samples.ts";
import { maxDeviation } from "./synth.ts";
import {
	boxAt,
	encodeFrames,
	padded,
	rowOf,
	timed,
	X264,
} from "./video-helpers.ts";

const FPS = 60;
const FRAME_MS = 1000 / FPS;
const DELAY = 200;
const DURATION = 600;
const EASE = [0.22, 1, 0.36, 1] as const;
const PAD = 12;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{margin:0;background:#f4f4f6}
.el{position:absolute;top:220px;width:200px;height:130px;background:#fff;border:3px solid #1d1d1f;border-radius:10px;
animation-duration:${DURATION}ms;animation-delay:${DELAY}ms;animation-fill-mode:both;
animation-timing-function:cubic-bezier(${EASE.join(",")})}
.el i{position:absolute;display:block;background:#2f6fed}
.el i:nth-child(1){left:16px;top:16px;width:70px;height:40px}
.el i:nth-child(2){left:110px;top:24px;width:60px;height:12px;background:#1d1d1f}
.el i:nth-child(3){left:16px;top:80px;width:150px;height:14px;background:#e0533d}
#grow{left:100px;animation-name:grow}
#blurin{left:520px;animation-name:blurin}
#both{left:940px;animation-name:both}
@keyframes grow{from{transform:scale(0.5)}to{transform:scale(1)}}
@keyframes blurin{from{filter:blur(16px)}to{filter:blur(0px)}}
@keyframes both{from{transform:translateY(80px) scale(0.5);filter:blur(16px)}to{transform:none;filter:blur(0px)}}
</style></head><body>
<div class="el" id="grow"><i></i><i></i><i></i></div>
<div class="el" id="blurin"><i></i><i></i><i></i></div>
<div class="el" id="both"><i></i><i></i><i></i></div>
</body></html>`;

const blurOf = (e: TrackedElement) =>
	Number(/blur\(([\d.]+)px\)/.exec(e.filter)?.[1] ?? 0);
const scaleOf = (e: TrackedElement) => decompose(e.transform).scale;

const series = (t: Track, sel: string, get: (e: TrackedElement) => number) =>
	t.frames.map((f) => get(f.elements[sel]?.[0] as TrackedElement));

/** First frame that has moved 5 % of the total change away from the first value. */
const startFrame = (v: number[]) => {
	const range = (v.at(-1) as number) - (v[0] as number);
	return v.findIndex(
		(x) => Math.abs(x - (v[0] as number)) > Math.abs(range) * 0.05,
	);
};

describe("video input: scale and blur", () => {
	let tmp: string;
	let dom: Track;
	let video: Track;
	let raw: RegionTrack[];
	let videoDir: string;
	const names = { grow: "#grow", blurin: "#blurin", both: "#both" };

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-scale-"));
		await writeFile(join(tmp, "page.html"), PAGE);
		const cap = await captureMotion({
			url: join(tmp, "page.html"),
			outDir: join(tmp, "dom"),
			durationMs: 1100,
			fps: FPS,
			track: Object.values(names),
		});
		dom = await readTrack(cap.outDir);
		await encodeFrames(cap.outDir, join(tmp, "page.mp4"), FPS, X264);
		const last = dom.frames.at(-1);
		const started = performance.now();
		const summary = await captureVideo({
			input: join(tmp, "page.mp4"),
			outDir: join(tmp, "video"),
			regions: Object.entries(names).map(([name, sel]) => ({
				name,
				...padded(boxAt(last, sel, 0), PAD),
			})),
		});
		console.log(
			`captureVideo ${summary.frames} frames, 3 regions: ${((performance.now() - started) / 1000).toFixed(1)} s`,
			JSON.stringify(summary.regions),
			summary.warnings,
		);
		videoDir = summary.outDir;
		video = await readTrack(videoDir);
		raw = JSON.parse(
			await readFile(join(videoDir, "regions.json"), "utf8"),
		).regions;
	}, 240_000);

	afterAll(async () => {
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	const compare = (
		name: keyof typeof names,
		get: (e: TrackedElement) => number,
		label: string,
	) => {
		const want = series(dom, names[name], get);
		const got = series(video, name, get);
		console.log(
			`${name} ${label}: ${got.map((v, k) => `${k}:${v.toFixed(2)}/${(want[k] as number).toFixed(2)}`).join(" ")}`,
		);
		return { want, got };
	};

	const foundShare = (name: keyof typeof names, moving: number[]) => {
		const first = startFrame(moving);
		const end = moving.findIndex((v, k) => k > first && v === moving.at(-1));
		const r = raw.find((t) => t.name === name) as RegionTrack;
		const span = r.samples.slice(first, end);
		const share = span.filter((s) => s.found).length / span.length;
		console.log(
			`${name}: found ${(share * 100).toFixed(0)} % of frames ${first}..${end - 1}`,
		);
		return share;
	};

	for (const name of ["grow", "both"] as const)
		it(`${name}: scale 0.5 to 1 with its start, easing and frames found`, async () => {
			const { want, got } = compare(name, scaleOf, "scale");
			expect(Math.abs((got[0] as number) - 0.5)).toBeLessThanOrEqual(0.03);
			expect(Math.abs((got.at(-1) as number) - 1)).toBeLessThanOrEqual(0.03);
			expect(Math.abs(startFrame(got) - startFrame(want))).toBeLessThanOrEqual(
				2,
			);
			const spec = await draftSpec(videoDir, { write: false });
			const row = rowOf(spec, `${name}[0].scale`);
			const startMs = startFrame(want) * FRAME_MS;
			const dev = maxDeviation(
				timed(row.easing, row.startMs, row.durationMs),
				timed(bezierEasing([...EASE]), DELAY, DURATION),
				DELAY - 60,
				DELAY + DURATION + 300,
			);
			console.log(
				`${name} scale row: start ${row.startMs} (dom ${startMs.toFixed(0)}), duration ${row.durationMs}, ${row.from} -> ${row.to}, curve dev ${dev.toFixed(4)}`,
			);
			expect(dev).toBeLessThan(0.05);
			expect(foundShare(name, want)).toBeGreaterThanOrEqual(0.9);
		});

	for (const name of ["blurin", "both"] as const)
		it(`${name}: blur 16 to 0 with its start and frames found`, () => {
			const { want, got } = compare(name, blurOf, "blur");
			expect(Math.abs((got[0] as number) - 16)).toBeLessThanOrEqual(2);
			const rest = startFrame(want) + Math.ceil(DURATION / FRAME_MS) + 1;
			for (const v of got.slice(rest)) expect(v).toBe(0);
			expect(Math.abs(startFrame(got) - startFrame(want))).toBeLessThanOrEqual(
				2,
			);
			expect(foundShare(name, want)).toBeGreaterThanOrEqual(0.9);
		});

	it("blur alone does not read as scale or fading", () => {
		const scale = series(video, "blurin", scaleOf);
		const op = series(video, "blurin", (e) => e.opacity);
		console.log(`blurin opacity: ${op.join(" ")}`);
		console.log(`blurin scale: ${scale.join(" ")}`);
		for (const s of scale) expect(Math.abs(s - 1)).toBeLessThanOrEqual(0.03);
		// The proxy compares against the blurred model, so blur does not lower it beyond h264 jitter.
		for (const o of op) expect(o).toBeGreaterThanOrEqual(0.9);
	});
});
