import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { blank, type Rgb } from "../media/image.ts";
import { drawText, GLYPH_HEIGHT } from "../report/font.ts";
import { pickFrames } from "./extract.ts";
import { scanFrames } from "./ffmpeg.ts";
import type { PixelRect } from "./options.ts";
import type { VideoProbe } from "./probe.ts";
import { decodeRaw } from "./raw.ts";

const MAX_TILES = 48;
const STEPS_MS = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 30_000];
const TILE_W = 240;
const GUTTER = 8;
const COLS = 7;
const LABEL = GLYPH_HEIGHT * 2 + 6;
const BACKGROUND: Rgb = [40, 40, 40];
const INK: Rgb = [240, 240, 240];

export interface ContactSheet {
	png: string;
	everyMs: number;
	tiles: { t: number; frame: number }[];
}

const defaultEvery = (durationS: number) =>
	STEPS_MS.find((s) => (durationS * 1000) / s < MAX_TILES) ??
	(STEPS_MS.at(-1) as number);

/** One labelled thumbnail every `everyMs` (time and decoder frame number), cropped to `crop`, in one PNG. */
export async function writeContactSheet(
	path: string,
	probe: VideoProbe,
	outDir: string,
	{ everyMs, crop }: { everyMs?: number; crop?: PixelRect },
): Promise<ContactSheet> {
	const scan = await scanFrames(path);
	const lastT = scan.frames.at(-1)?.t ?? 0;
	const every = everyMs ?? defaultEvery(lastT);
	if (!(every > 0)) throw new Error("the sheet interval must be above 0 ms");
	const count = Math.floor((lastT * 1000) / every + 1e-9) + 1;
	if (count > 400)
		throw new Error(
			`${count} tiles at every ${every} ms: use a larger interval`,
		);
	const picked = pickFrames(scan, 0, 1000 / every, count);
	const unique = [...new Set(picked)].sort((p, q) => p - q);
	const area = crop ?? { x: 0, y: 0, w: probe.width, h: probe.height };
	const tileH = Math.max(1, Math.round((area.h * TILE_W) / area.w));
	const filters = [
		`select='${unique.map((n) => `eq(n,${n})`).join("+")}'`,
		"format=rgb24",
		`crop=${area.w}:${area.h}:${area.x}:${area.y}`,
		`scale=${TILE_W}:${tileH}`,
	].join(",");
	const thumbs = new Map<number, Uint8Array>();
	await decodeRaw(
		path,
		{
			width: TILE_W,
			height: tileH,
			pixFmt: "rgb24",
			bytesPerPixel: 3,
			filters,
		},
		(f, k) => thumbs.set(unique[k] as number, f.slice()),
	);
	const cols = Math.min(COLS, count);
	const rows = Math.ceil(count / cols);
	const sheet = blank(
		GUTTER + cols * (TILE_W + GUTTER),
		GUTTER + rows * (LABEL + tileH + GUTTER),
		BACKGROUND,
	);
	const tiles: ContactSheet["tiles"] = [];
	for (const [i, n] of picked.entries()) {
		const x0 = GUTTER + (i % cols) * (TILE_W + GUTTER);
		const y0 = GUTTER + Math.floor(i / cols) * (LABEL + tileH + GUTTER);
		const t = (i * every) / 1000;
		drawText(sheet, `${t.toFixed(2)} s  #${n}`, x0, y0, INK, 2);
		const rgb = thumbs.get(n);
		if (!rgb) throw new Error(`ffmpeg did not decode frame ${n}`);
		for (let y = 0; y < tileH; y++)
			for (let x = 0; x < TILE_W; x++) {
				const s = (y * TILE_W + x) * 3;
				const d = ((y0 + LABEL + y) * sheet.width + x0 + x) * 4;
				sheet.data[d] = rgb[s] as number;
				sheet.data[d + 1] = rgb[s + 1] as number;
				sheet.data[d + 2] = rgb[s + 2] as number;
			}
		tiles.push({ t, frame: n });
	}
	await mkdir(resolve(outDir), { recursive: true });
	const png = join(resolve(outDir), "contact-sheet.png");
	await writeFile(png, PNG.sync.write(sheet));
	return { png, everyMs: every, tiles };
}
