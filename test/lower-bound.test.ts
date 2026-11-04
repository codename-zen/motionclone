import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOWER_BOUND_NOTE } from "../src/spec/clipped.ts";
import { draftSpec } from "../src/spec/draft.ts";
import { verify } from "../src/verify/index.ts";
import { FAKE_FRAME_MS, fakeTrackCapture } from "./fake-capture.ts";

let root: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-lower-bound-"));
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

const ease = (k: number) =>
	Math.min(1, Math.max(0, (k * FAKE_FRAME_MS - 300) / 400));

/** A card that slides down by `distance`; with `clipped`, the tracker flags it at its region edge while it moves. */
const slide = (name: string, distance: number, clipped = false) =>
	fakeTrackCapture(join(root, name), 45, (k) => ({
		card: {
			y: 20 + distance * ease(k),
			...(clipped && ease(k) > 0.5 ? { clipped: true } : {}),
		},
	}));

describe("a distance cut short by the region edge", () => {
	it("is drafted as a lower bound, and a longer clone move passes", async () => {
		const ref = await slide("ref", 100, true);
		const spec = await draftSpec(ref, { write: false });
		const row = spec.rows.find((r) => r.id === "card[0].y");
		expect(row?.distanceObserved).toBe("lower-bound");
		expect(row?.notes).toContain(LOWER_BOUND_NOTE);

		const longer = await verify(spec, ref, await slide("longer", 160), {
			outDir: false,
		});
		const r = longer.rows.find((x) => x.id === "card[0].y");
		expect(r?.metrics.distance?.pass).toBe(true);
		expect(r?.notes.join(" ")).toMatch(/lower bound/);

		const shorter = await verify(spec, ref, await slide("shorter", 60), {
			outDir: false,
		});
		expect(
			shorter.rows.find((x) => x.id === "card[0].y")?.metrics.distance?.pass,
		).toBe(false);
	});

	it("reads the clipped travel a video capture lists in capture.json", async () => {
		const clipped = [{ selector: "card", index: 0, fromMs: 500, toMs: 700 }];
		const ref = await fakeTrackCapture(
			join(root, "ranges"),
			45,
			(k) => ({ card: { y: 20 + 100 * ease(k) } }),
			{ video: { clippedTravel: clipped } },
		);
		const spec = await draftSpec(ref, { write: false });
		expect(spec.rows[0]?.distanceObserved).toBe("lower-bound");
	});

	it("stays a full distance without the flag, so a longer move fails", async () => {
		const ref = await slide("plain", 100);
		const spec = await draftSpec(ref, { write: false });
		expect(spec.rows[0]?.distanceObserved).toBe("full");
		const v = await verify(spec, ref, await slide("plain-longer", 160), {
			outDir: false,
		});
		expect(v.rows[0]?.metrics.distance?.pass).toBe(false);
	});
});
