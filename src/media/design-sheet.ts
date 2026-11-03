import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { drawText, GLYPH_HEIGHT, textWidth } from "../report/font.ts";
import { FrameReader, frameAt, frameTime, readClip } from "./clip.ts";
import { blank, fitInto, type Rgb } from "./image.ts";
import { restFrames } from "./rest-frames.ts";

export interface DesignSheetResult {
	png: string;
	moments: { label: string; refFrame: number; cloneFrame: number; t: number }[];
}

const BACKGROUND: Rgb = [40, 40, 40];
const PANEL: Rgb = [0, 0, 0];
const INK: Rgb = [240, 240, 240];
const MUTED: Rgb = [170, 170, 170];
const GUTTER = 8;
const SCALE = 2;
const LINE = GLYPH_HEIGHT * SCALE + 6;
const MAX_TILE_WIDTH = 560;
const TITLES = ["Reference", "Clone", "Difference"] as const;

/** Reference | clone | difference at the first frame, the last frame and each still stretch, in one PNG. */
export async function designSheet(
	refDir: string,
	cloneDir: string,
	outDir: string,
): Promise<DesignSheetResult> {
	const [ref, clone] = await Promise.all([
		readClip(resolve(refDir)),
		readClip(resolve(cloneDir)),
	]);
	const refs = new FrameReader(ref);
	const clones = new FrameReader(clone);
	const picks = await restFrames(ref);
	const first = await refs.read(0);
	const tileW = Math.min(first.width, MAX_TILE_WIDTH);
	const tileH = Math.max(1, Math.round((first.height * tileW) / first.width));
	const width = 3 * tileW + 4 * GUTTER;
	const rowH = LINE + tileH + GUTTER;
	const sheet = blank(width, GUTTER + LINE + picks.length * rowH, BACKGROUND);
	for (const [col, title] of TITLES.entries()) {
		const s = textWidth(title, SCALE) <= tileW ? SCALE : 1;
		drawText(sheet, title, GUTTER + col * (tileW + GUTTER), GUTTER, INK, s);
	}
	const moments: DesignSheetResult["moments"] = [];
	for (const [row, refFrame] of picks.entries()) {
		const t = frameTime(ref, refFrame);
		const cloneFrame = frameAt(clone, t);
		const a = fitInto(await refs.read(refFrame), tileW, tileH, PANEL);
		const b = fitInto(await clones.read(cloneFrame), tileW, tileH, PANEL);
		const diff = new PNG({ width: tileW, height: tileH });
		pixelmatch(a.data, b.data, diff.data, tileW, tileH, { threshold: 0.1 });
		const kind =
			refFrame === 0
				? "first frame"
				: refFrame === ref.frames - 1
					? "last frame"
					: "rest";
		const label = `${kind} ${Math.round(t)} ms`;
		const y0 = GUTTER + LINE + row * rowH;
		drawText(sheet, label, GUTTER, y0, MUTED, SCALE);
		for (const [col, img] of [a, b, diff].entries())
			PNG.bitblt(
				img,
				sheet,
				0,
				0,
				tileW,
				tileH,
				GUTTER + col * (tileW + GUTTER),
				y0 + LINE,
			);
		moments.push({ label, refFrame, cloneFrame, t });
	}
	await mkdir(resolve(outDir), { recursive: true });
	const png = join(resolve(outDir), "design-sheet.png");
	await writeFile(png, PNG.sync.write(sheet));
	return { png, moments };
}
