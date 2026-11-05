import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { type RestFrame, restFramesOf } from "../look/rest.ts";
import { drawText, GLYPH_HEIGHT, textWidth } from "../report/font.ts";
import { readCaptureFile } from "../spec/capture-file.ts";
import { FrameReader, frameAt, frameTime, readClip } from "./clip.ts";
import { blank, differenceImage, fitInto, type Rgb, resize } from "./image.ts";

export interface DesignSheetResult {
	png: string;
	moments: {
		label: string;
		refFrame: number;
		cloneFrame: number;
		t: number;
		/** Time of the clone frame shown, ms from its trigger. */
		cloneT: number;
	}[];
	/** The clone's screen in CSS px when it differs from the reference's; null when they match. */
	cloneSize: { width: number; height: number } | null;
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

const KIND: Record<RestFrame["label"], string> = {
	first: "first rest",
	plateau: "rest",
	last: "last frame",
};

/** The screen of a capture in CSS px; a capture without a crop record counts its frame pixels. */
async function screenOf(dir: string, png: PNG) {
	const clip = await readCaptureFile(dir)
		.then((c) => c.clip)
		.catch(() => undefined);
	return clip
		? { width: clip.width, height: clip.height }
		: { width: png.width, height: png.height };
}

/**
 * The clone drawn at the reference's CSS scale from the top-left corner, as verify compares them: a clone of another
 * screen size is cut or padded, never stretched or centred, so the difference shows no shift that is not there.
 */
function cloneTile(
	img: PNG,
	tilePerCss: number,
	cloneCss: { width: number },
	tileW: number,
	tileH: number,
): PNG {
	const k = (tilePerCss * cloneCss.width) / img.width;
	const w = Math.max(1, Math.round(img.width * k));
	const h = Math.max(1, Math.round(img.height * k));
	if (Math.abs(w - tileW) <= 1 && Math.abs(h - tileH) <= 1)
		return resize(img, tileW, tileH);
	const out = blank(tileW, tileH, PANEL);
	PNG.bitblt(
		resize(img, w, h),
		out,
		0,
		0,
		Math.min(w, tileW),
		Math.min(h, tileH),
		0,
		0,
	);
	return out;
}

/** Reference | clone | difference at each rest state look.json measures (src/look/rest.ts) and the last frame, in one PNG. */
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
	const picks = await restFramesOf(ref.dir, ref.frames, ref.frameMs);
	const first = await refs.read(0);
	const tileW = Math.min(first.width, MAX_TILE_WIDTH);
	const tileH = Math.max(1, Math.round((first.height * tileW) / first.width));
	const [refCss, cloneCss] = await Promise.all([
		screenOf(ref.dir, first),
		screenOf(clone.dir, await clones.read(0)),
	]);
	const tilePerCss = tileW / refCss.width;
	const same =
		refCss.width === cloneCss.width && refCss.height === cloneCss.height;
	const titles = [
		TITLES[0],
		same
			? TITLES[1]
			: `${TITLES[1]}, ${cloneCss.width}x${cloneCss.height} CSS px`,
		TITLES[2],
	];
	const width = 3 * tileW + 4 * GUTTER;
	const rowH = LINE + tileH + GUTTER;
	const sheet = blank(width, GUTTER + LINE + picks.length * rowH, BACKGROUND);
	for (const [col, title] of titles.entries()) {
		const s = textWidth(title, SCALE) <= tileW ? SCALE : 1;
		drawText(sheet, title, GUTTER + col * (tileW + GUTTER), GUTTER, INK, s);
	}
	const moments: DesignSheetResult["moments"] = [];
	for (const [row, pick] of picks.entries()) {
		const refFrame = pick.frame;
		const t = frameTime(ref, refFrame);
		const cloneFrame = frameAt(clone, t);
		const cloneT = frameTime(clone, cloneFrame);
		const a = fitInto(await refs.read(refFrame), tileW, tileH, PANEL);
		const b = cloneTile(
			await clones.read(cloneFrame),
			tilePerCss,
			cloneCss,
			tileW,
			tileH,
		);
		const diff = differenceImage(a, b);
		// A clone frame at another time is named, so a timing gap does not pass for a layout difference.
		const label = `${KIND[pick.label]} ${Math.round(t)} ms${Math.round(cloneT) === Math.round(t) ? "" : `, clone ${Math.round(cloneT)} ms`}`;
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
		moments.push({ label, refFrame, cloneFrame, t, cloneT });
	}
	await mkdir(resolve(outDir), { recursive: true });
	const png = join(resolve(outDir), "design-sheet.png");
	await writeFile(png, PNG.sync.write(sheet));
	return { png, moments, cloneSize: same ? null : cloneCss };
}
