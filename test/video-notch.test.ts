import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrackedElement } from "../src/capture/types.ts";
import { readTrack, type Track } from "../src/measure/elements.ts";
import { readProperty } from "../src/measure/series.ts";
import { captureVideo } from "../src/video/index.ts";
import type { RegionTrack } from "../src/video/samples.ts";
import { type CaptureSession, openCaptureSession } from "./capture-session.ts";
import {
	type Box,
	boxAt,
	encodeFrames,
	padded,
	X264,
} from "./video-helpers.ts";

const FPS = 60;
const PAD = 12;
// The expanded content starts entering at 450 ms (art) and 480 ms (title).
const ENTERS_MS = 450;
const MAX_BLUR = 24;
const NAMES = { art: ".art", title: ".title" } as const;

const union = (a: Box, b: Box): Box => {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		w: Math.max(a.x + a.w, b.x + b.w) - x,
		h: Math.max(a.y + a.h, b.y + b.h) - y,
	};
};

describe("video input: a dark notch whose content swaps while it expands", () => {
	let session: CaptureSession;
	let tmp: string;
	let dom: Track;
	let video: Track;
	let raw: RegionTrack[];

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "motionclone video-notch-"));
		session = await openCaptureSession("video-notch");
		const domDir = await session.capture("notch-expand", "dom", {
			durationMs: 1200,
			fps: FPS,
			viewport: { width: 1200, height: 520 },
			track: Object.values(NAMES),
		});
		dom = await readTrack(domDir);
		await encodeFrames(domDir, join(tmp, "notch.mp4"), FPS, X264);
		const summary = await captureVideo({
			input: join(tmp, "notch.mp4"),
			outDir: join(tmp, "video"),
			regions: Object.entries(NAMES).map(([name, sel]) => ({
				name,
				...padded(
					union(boxAt(dom.frames[0], sel, 0), boxAt(dom.frames.at(-1), sel, 0)),
					PAD,
				),
			})),
		});
		video = await readTrack(summary.outDir);
		raw = JSON.parse(
			await readFile(join(summary.outDir, "regions.json"), "utf8"),
		).regions;
	}, 240_000);

	afterAll(async () => {
		await session?.close();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	const el = (t: Track, sel: string, k: number) =>
		t.frames[k]?.elements[sel]?.[0] as TrackedElement;
	const samples = (name: string) =>
		(raw.find((r) => r.name === name) as RegionTrack).samples;

	for (const [name, sel] of Object.entries(NAMES)) {
		it(`${name}: nothing is measured before the expanded content appears`, () => {
			dom.frames.forEach((f, k) => {
				if (f.t >= ENTERS_MS) return;
				const e = el(video, name, k);
				expect(samples(name)[k]?.found).toBe(false);
				expect(e.observed).toMatchObject({
					position: false,
					scale: false,
					blur: false,
				});
				expect(e.opacity).toBe(0);
			});
		});

		it(`${name}: scale and blur follow the page once visible, and rest at 1 and 0`, () => {
			const worst = { scale: 0, blur: 0 };
			dom.frames.forEach((_, k) => {
				const e = el(video, name, k);
				if (e.opacity < 0.3) return;
				expect(e.observed?.scale).toBe(true);
				for (const p of ["scale", "blur"] as const)
					worst[p] = Math.max(
						worst[p],
						Math.abs(readProperty(e, p) - readProperty(el(dom, sel, k), p)),
					);
			});
			console.log(`${name} worst error once the proxy reads 0.3`, worst);
			expect(worst.scale).toBeLessThanOrEqual(0.05);
			expect(worst.blur).toBeLessThanOrEqual(3);
			const rest = video.frames.at(-1)?.elements[name]?.[0];
			expect(rest?.transform).toBe("none");
			expect(rest?.filter).toBe("none");
		});

		it(`${name}: first found within 2 frames of the page opacity crossing 0.2`, () => {
			const op = dom.frames.map((_, k) => el(dom, sel, k).opacity);
			const k1 = op.findIndex((v) => v >= 0.2);
			const crossing =
				k1 -
				1 +
				(0.2 - (op[k1 - 1] as number)) /
					((op[k1] as number) - (op[k1 - 1] as number));
			const first = samples(name).findIndex((s) => s.found);
			console.log(
				`${name}: first found ${first}, page crosses 0.2 at ${crossing.toFixed(2)}`,
			);
			expect(Math.abs(first - crossing)).toBeLessThanOrEqual(2);
		});
	}

	it("never reports an absurd scale or blur, or an opacity outside 0..1", () => {
		for (const name of Object.keys(NAMES))
			video.frames.forEach((_, k) => {
				const e = el(video, name, k);
				expect(readProperty(e, "scale")).toBeGreaterThanOrEqual(0.3);
				expect(readProperty(e, "blur")).toBeLessThanOrEqual(2 * MAX_BLUR);
				expect(e.opacity).toBeGreaterThanOrEqual(0);
				expect(e.opacity).toBeLessThanOrEqual(1);
				expect(e.quality).toBeGreaterThanOrEqual(0);
				expect(e.quality).toBeLessThanOrEqual(1);
			});
	});

	it("marks frames where the expanding panel crosses the region as other content", () => {
		const other = samples("art").flatMap((s, k) =>
			s.status === "other" ? [k] : [],
		);
		console.log(`art: other content on frames ${other.join(" ")}`);
		expect(other.length).toBeGreaterThan(0);
		for (const k of other) {
			expect(el(video, "art", k).observed?.opacity).toBe(false);
			expect(dom.frames[k]?.t).toBeLessThan(ENTERS_MS);
		}
	});
});
