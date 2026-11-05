import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { draftSpec } from "../src/spec/draft.ts";
import { verify } from "../src/verify/index.ts";
import { FAKE_FRAME_MS, fakeTrackCapture } from "./fake-capture.ts";

let root: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-pairing-"));
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

const FRAMES = 150;
const ramp = (t: number, start: number) =>
	Math.min(1, Math.max(0, (t - start) / 300));
// A strip that moves down, down again, back up and up to where it began, one second apart.
const stripY = (t: number) =>
	100 +
	200 * (ramp(t, 300) + ramp(t, 1300) - ramp(t, 2300) - ramp(t, 3300)) +
	(t > 4200 ? 50 * ramp(t, 4200) : 0);

const LOST = { position: false, scale: false, blur: false, opacity: false };

/** The strip at every frame; `lostFrom..lostTo` ms are frames a video tracker lost it on, `bump` adds a late move. */
const capture = (
	name: string,
	{ lost, bump = false }: { lost?: [number, number]; bump?: boolean },
) =>
	fakeTrackCapture(join(root, name), FRAMES, (k) => {
		const t = k * FAKE_FRAME_MS;
		const y = bump ? stripY(t) : stripY(Math.min(t, 4100));
		const gone = lost && t >= lost[0] && t <= lost[1];
		return { strip: { y, ...(gone ? { observed: LOST } : {}) } };
	});

describe("pairing motions by time and shape", () => {
	it("pairs each row with the clone motion like it when the reference misses one", async () => {
		const ref = await capture("ref", { lost: [2200, 2800] });
		const spec = await draftSpec(ref, { write: false });
		const rows = spec.rows.filter((r) => r.property === "y");
		expect(rows.map((r) => Math.round(r.startMs / 100) * 100)).toEqual([
			300, 1300, 3300,
		]);
		const v = await verify(spec, ref, await capture("clone", {}), {
			outDir: false,
		});
		expect(v.rows.filter((r) => !r.pass).map((r) => r.message)).toEqual([]);
		expect(v.unpaired).toEqual([
			"strip[0] y: the clone also moves 500 px -> 300 px from 2333 ms over 267 ms, where the reference does not show the element clearly (lost, faded or cut off), so this motion is not checked",
		]);
	});

	it("fails an extra clone motion where the reference holds still", async () => {
		const ref = await capture("ref-still", {});
		const spec = await draftSpec(ref, { write: false });
		const v = await verify(spec, ref, await capture("bump", { bump: true }), {
			outDir: false,
		});
		const failing = v.rows.filter((r) => !r.pass);
		expect(failing.map((r) => r.id)).toEqual(["strip[0].y#4"]);
		expect(failing[0]?.message).toBe(
			"strip[0] y has 5 motions, want 4: remove the one 100 px -> 150 px from 4233 ms over 267 ms, where the reference holds still",
		);
		expect(v.unpaired).toEqual([]);
	});
});
