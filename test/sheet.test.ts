import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Track } from "../src/measure/elements.ts";
import { writeSheets } from "../src/report/sheet.ts";
import { Verdict } from "../src/verify/schema.ts";
import { element, fakeTrackCapture } from "./fake-capture.ts";

// Frames of 128 px for a 64 CSS px screen: two frame pixels per CSS pixel, as a 2x recording.
const SIZE = 128;
const BOX = { x: 40, y: 40, w: 10, h: 10 };

async function scaledFrames(dir: string, frames: number) {
	const png = new PNG({ width: SIZE, height: SIZE });
	png.data.fill(255);
	for (let y = BOX.y * 2; y < (BOX.y + BOX.h) * 2; y++)
		for (let x = BOX.x * 2; x < (BOX.x + BOX.w) * 2; x++)
			png.data.set([0, 0, 0, 255], (y * SIZE + x) * 4);
	const bytes = PNG.sync.write(png);
	for (let k = 0; k < frames; k++)
		await writeFile(
			join(dir, "frames", `${String(k).padStart(4, "0")}.png`),
			bytes,
		);
}

let root: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-sheet-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

const verdictOf = (ref: string, clone: string) =>
	Verdict.parse({
		version: 1,
		referenceDir: ref,
		cloneDir: clone,
		fidelity: "motion",
		setupErrors: [],
		rows: [
			{
				id: "panel::edge[0].y",
				kind: "motion",
				selector: "panel::edge",
				index: 0,
				property: "y",
				pass: false,
				metrics: {},
				failures: ["panel::edge[0] y starts 100 ms late"],
				message: "panel::edge[0] y starts 100 ms late",
				focusMs: [100],
			},
		],
		pixel: null,
		warnings: [],
		summary: { rows: 1, passed: 0, failed: 1 },
		pass: false,
	});

describe("failure sheets", () => {
	it("crop the row's box in frame pixels, with the clone as verify measured it", async () => {
		const ref = await fakeTrackCapture(join(root, "ref"), 6, () => ({
			"panel::edge": BOX,
		}));
		const clone = await fakeTrackCapture(join(root, "clone"), 6, () => ({
			"#panel": BOX,
		}));
		await scaledFrames(ref, 6);
		await scaledFrames(clone, 6);
		// The measured clone names the edge like the reference and finds it 30 CSS px further left.
		const raw = JSON.parse(
			await readFile(join(clone, "track.json"), "utf8"),
		) as Track;
		const measured: Track = {
			...raw,
			frames: raw.frames.map((f) => ({
				...f,
				elements: { "panel::edge": [element({ ...BOX, x: 10 })] },
			})),
		};
		const [sheet] = await writeSheets(
			verdictOf(ref, clone),
			join(root, "sheets"),
			measured,
		);
		const c = sheet?.crop ?? { x: 0, y: 0, width: 0, height: 0 };
		expect(c.x).toBeLessThanOrEqual(2 * 10);
		expect(c.x + c.width).toBeGreaterThanOrEqual(2 * (BOX.x + BOX.w));
		expect(c.y).toBeLessThanOrEqual(2 * BOX.y);
		expect(c.y + c.height).toBeGreaterThanOrEqual(2 * (BOX.y + BOX.h));
		// The reference tile shows the black box, and a tick beside the tile marks its top.
		const png = PNG.sync.read(await readFile(sheet?.png as string));
		const tile = sheet?.tiles[0] ?? { x: 0, y: 0 };
		const at = (x: number, y: number) => [
			...png.data.subarray(
				(y * png.width + x) * 4,
				(y * png.width + x) * 4 + 3,
			),
		];
		expect(
			at(tile.x + 2 * BOX.x - c.x + 5, tile.y + 2 * BOX.y - c.y + 5),
		).toEqual([0, 0, 0]);
		expect(at(tile.x - 2, tile.y + 2 * BOX.y - c.y)).toEqual([0, 200, 255]);
	});
});
