import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { draftSpec } from "../src/spec/draft.ts";
import { UNSEEN_END_NOTE } from "../src/verify/evidence.ts";
import { verify } from "../src/verify/index.ts";
import { FAKE_FRAME_MS, fakeTrackCapture } from "./fake-capture.ts";

let root: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-unseen-end-"));
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

const FRAMES = 60;
const progress = (t: number) => Math.min(1, Math.max(0, (t - 500) / 400));
const easeIn = (p: number) => p * p;
const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
const LOST = { position: false, scale: false, blur: false, opacity: false };
const VIDEO = { source: "video", video: { scale: 1, cssScale: 1 } };

/**
 * A strip that slides 300 px down along `curve` from 500 ms over 400 ms and fades out with it at `goneMs`; with
 * `video`, a tracker that loses it there, as a strip that morphs into a pill on a recording.
 */
const slide = (
	name: string,
	curve: (p: number) => number,
	{ goneMs, video = false }: { goneMs: number; video?: boolean },
) =>
	fakeTrackCapture(
		join(root, name),
		FRAMES,
		(k) => {
			const t = k * FAKE_FRAME_MS;
			const gone = t >= goneMs;
			return {
				strip: {
					y: 100 + 300 * curve(progress(Math.min(t, video ? goneMs : t))),
					opacity: gone ? 0 : 1,
					...(gone && video ? { observed: LOST } : {}),
				},
			};
		},
		video ? VIDEO : {},
	);

describe("a motion whose end the reference never shows", () => {
	it("is drafted from its visible part and checks the clone against it", async () => {
		const ref = await slide("ref", easeIn, { goneMs: 834, video: true });
		const spec = await draftSpec(ref, { write: false });
		const row = spec.rows.find((r) => r.id === "strip[0].y");
		expect(row?.fromObserved).toBe(true);
		expect(row?.toObserved).toBe(false);
		expect(row?.from).toBeCloseTo(100, 0);
		expect(Math.abs((row?.startMs ?? 0) - 500)).toBeLessThan(2 * FAKE_FRAME_MS);
		expect(row?.notes[0]).toMatch(/^end value not visible in the reference/);
		expect(row?.confidence).not.toBe("low");

		const same = await verify(
			spec,
			ref,
			await slide("same", easeIn, { goneMs: 900 }),
			{ outDir: false },
		);
		const r = same.rows.find((x) => x.id === "strip[0].y");
		expect(r?.message).toBe("strip[0].y matches the spec");
		expect(r?.notes).toContain(UNSEEN_END_NOTE);

		const wrong = await verify(
			spec,
			ref,
			await slide("wrong", easeOut, { goneMs: 900 }),
			{ outDir: false },
		);
		const w = wrong.rows.find((x) => x.id === "strip[0].y");
		expect(w?.pass).toBe(false);
		expect(w?.advisory).toBeNull();
		expect(w?.message).toMatch(
			/does not match the part of the motion the reference shows/,
		);
	});
});

describe("a motion the tracker did not see happen", () => {
	it("is low confidence when most of its change falls between readings frames apart", async () => {
		// Found at x 20, lost for seven frames, found again at x 30: the move happened where nothing was read.
		const ref = await fakeTrackCapture(
			join(root, "jump"),
			FRAMES,
			(k) => ({
				pill: {
					x: k < 24 ? 20 : 30,
					...(k >= 21 && k < 28 ? { observed: LOST, opacity: 0 } : {}),
				},
			}),
			VIDEO,
		);
		const spec = await draftSpec(ref, { write: false });
		const row = spec.rows.find((r) => r.id === "pill[0].x");
		expect(row?.confidence).toBe("low");
		expect(row?.support?.weak).toContain(
			"100 % of the change falls between the readings at 667 and 933 ms, where the element was not seen",
		);
	});
});
