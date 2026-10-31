import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { readTrack, type Track } from "../measure/elements.ts";
import { readCaptureFile } from "../spec/capture-file.ts";
import { readPng } from "../verify/pixels.ts";
import type { RowVerdict, Verdict } from "../verify/schema.ts";

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SheetTile {
	kind: "reference" | "clone" | "diff";
	frame: number;
	t: number;
	/** Position of the tile inside the sheet PNG. */
	x: number;
	y: number;
}

export interface SheetInfo {
	id: string;
	message: string;
	png: string;
	/** Region of the captured frames each tile shows, in frame pixels. */
	crop: Rect;
	tileWidth: number;
	tileHeight: number;
	tiles: SheetTile[];
}

const GUTTER = 8;
const PAD = 24;
const MAX_TIMES = 3;
const BACKGROUND = [40, 40, 40, 255];

const slug = (id: string) =>
	id
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase();

function nearestFrame(track: Track, t: number): number {
	let best = 0;
	track.frames.forEach((f, i) => {
		if (Math.abs(f.t - t) < Math.abs((track.frames[best]?.t ?? 0) - t))
			best = i;
	});
	return best;
}

/** Union of the row element's boxes at the chosen frames, in frame pixels, padded and clamped. */
function cropFor(
	row: RowVerdict,
	frames: number[],
	tracks: { track: Track; clip: Rect }[],
	size: { width: number; height: number },
): Rect {
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const { track, clip } of tracks)
		for (const f of frames) {
			const e = track.frames[f]?.elements[row.selector]?.find(
				(el) => el.index === row.index,
			);
			if (!e || e.w === 0 || e.h === 0) continue;
			x0 = Math.min(x0, e.x - clip.x);
			y0 = Math.min(y0, e.y - clip.y);
			x1 = Math.max(x1, e.x + e.w - clip.x);
			y1 = Math.max(y1, e.y + e.h - clip.y);
		}
	if (!Number.isFinite(x0)) return { x: 0, y: 0, ...size };
	const x = Math.max(0, Math.floor(x0 - PAD));
	const y = Math.max(0, Math.floor(y0 - PAD));
	return {
		x,
		y,
		width: Math.min(size.width, Math.ceil(x1 + PAD)) - x,
		height: Math.min(size.height, Math.ceil(y1 + PAD)) - y,
	};
}

function crop(src: PNG, r: Rect): PNG {
	const out = new PNG({ width: r.width, height: r.height });
	PNG.bitblt(src, out, r.x, r.y, r.width, r.height, 0, 0);
	return out;
}

/** One PNG per failing row: a line per moment with reference | clone | diff tiles. */
async function writeSheet(
	row: RowVerdict,
	v: Verdict,
	tracks: { ref: Track; clone: Track; refClip: Rect; cloneClip: Rect },
	outDir: string,
): Promise<SheetInfo> {
	const frames = [
		...new Set(row.focusMs.map((t) => nearestFrame(tracks.ref, t))),
	]
		.sort((a, b) => a - b)
		.slice(0, MAX_TIMES);
	const [refFirst, cloneFirst] = await Promise.all([
		readPng(v.referenceDir, frames[0] ?? 0),
		readPng(v.cloneDir, frames[0] ?? 0),
	]);
	const area = cropFor(
		row,
		frames,
		[
			{ track: tracks.ref, clip: tracks.refClip },
			{ track: tracks.clone, clip: tracks.cloneClip },
		],
		{
			width: Math.min(refFirst.width, cloneFirst.width),
			height: Math.min(refFirst.height, cloneFirst.height),
		},
	);
	const sheet = new PNG({
		width: 3 * area.width + 4 * GUTTER,
		height: frames.length * (area.height + GUTTER) + GUTTER,
	});
	for (let i = 0; i < sheet.data.length; i += 4) sheet.data.set(BACKGROUND, i);
	const tiles: SheetTile[] = [];
	for (const [line, frame] of frames.entries()) {
		const a = crop(await readPng(v.referenceDir, frame), area);
		const b = crop(await readPng(v.cloneDir, frame), area);
		const diff = new PNG({ width: area.width, height: area.height });
		pixelmatch(a.data, b.data, diff.data, area.width, area.height, {
			threshold: 0.1,
		});
		const y = GUTTER + line * (area.height + GUTTER);
		const t = tracks.ref.frames[frame]?.t ?? 0;
		for (const [col, [kind, img]] of (
			[
				["reference", a],
				["clone", b],
				["diff", diff],
			] as const
		).entries()) {
			const x = GUTTER + col * (area.width + GUTTER);
			PNG.bitblt(img, sheet, 0, 0, area.width, area.height, x, y);
			tiles.push({ kind, frame, t, x, y });
		}
	}
	const png = join(outDir, `${slug(row.id)}.png`);
	await writeFile(png, PNG.sync.write(sheet));
	return {
		id: row.id,
		message: row.message,
		png,
		crop: area,
		tileWidth: area.width,
		tileHeight: area.height,
		tiles,
	};
}

/** Comparison sheets for failing rows only, each with a JSON sidecar; returns what was written. */
export async function writeSheets(
	v: Verdict,
	outDir: string,
): Promise<SheetInfo[]> {
	const failing = v.rows.filter((r) => !r.pass);
	if (v.setupErrors.length > 0 || failing.length === 0) return [];
	await mkdir(outDir, { recursive: true });
	const [ref, clone, refCap, cloneCap] = await Promise.all([
		readTrack(v.referenceDir),
		readTrack(v.cloneDir),
		readCaptureFile(v.referenceDir),
		readCaptureFile(v.cloneDir),
	]);
	const tracks = { ref, clone, refClip: refCap.clip, cloneClip: cloneCap.clip };
	const out: SheetInfo[] = [];
	for (const row of failing) {
		const info = await writeSheet(row, v, tracks, outDir);
		await writeFile(
			info.png.replace(/\.png$/, ".json"),
			`${JSON.stringify(info, null, "\t")}\n`,
		);
		out.push(info);
	}
	return out;
}
