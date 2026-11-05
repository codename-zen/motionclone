import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { readTrack, type Track } from "../measure/elements.ts";
import { differenceImage } from "../media/image.ts";
import { readCaptureFile } from "../spec/capture-file.ts";
import { readPng } from "../verify/pixels.ts";
import type { RowVerdict, Verdict } from "../verify/schema.ts";
import { drawText, GLYPH_HEIGHT, textWidth, wrapText } from "./font.ts";

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
	/** Height of the text block above the first row: id, message and column titles. */
	headerHeight: number;
	tileWidth: number;
	tileHeight: number;
	tiles: SheetTile[];
}

const GUTTER = 8;
const PAD = 24;
const MAX_TIMES = 3;
const MAX_MESSAGE_LINES = 4;
const TEXT_SCALE = 2;
const LINE_HEIGHT = GLYPH_HEIGHT * TEXT_SCALE + 6;
const BACKGROUND = [40, 40, 40, 255];
const INK = [240, 240, 240] as const;
const MUTED = [170, 170, 170] as const;
const COLUMN_TITLES = ["Reference", "Clone", "Difference"] as const;
const MARK = [0, 200, 255, 255];
const TICK = 6;

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

/** One capture's track, its crop in CSS px and its frame pixels per CSS px. */
interface Side {
	track: Track;
	clip: Rect;
	scale: number;
}

/** The row element's box on one frame, in that capture's frame pixels. */
function boxAt(row: RowVerdict, side: Side, frame: number): Rect | null {
	const e = side.track.frames[frame]?.elements[row.selector]?.find(
		(el) => el.index === row.index,
	);
	if (!e || e.w === 0 || e.h === 0) return null;
	return {
		x: (e.x - side.clip.x) * side.scale,
		y: (e.y - side.clip.y) * side.scale,
		width: e.w * side.scale,
		height: e.h * side.scale,
	};
}

/** Union of the row element's boxes at the chosen frames, in frame pixels, padded and clamped. */
function cropFor(
	row: RowVerdict,
	frames: number[],
	sides: Side[],
	size: { width: number; height: number },
): Rect {
	const boxes = sides.flatMap((s) =>
		frames.flatMap((f) => boxAt(row, s, f) ?? []),
	);
	if (boxes.length === 0) return { x: 0, y: 0, ...size };
	const x0 = Math.min(...boxes.map((b) => b.x));
	const y0 = Math.min(...boxes.map((b) => b.y));
	const x1 = Math.max(...boxes.map((b) => b.x + b.width));
	const y1 = Math.max(...boxes.map((b) => b.y + b.height));
	const x = Math.max(0, Math.min(size.width - 1, Math.floor(x0 - PAD)));
	const y = Math.max(0, Math.min(size.height - 1, Math.floor(y0 - PAD)));
	return {
		x,
		y,
		width: Math.max(1, Math.min(size.width, Math.ceil(x1 + PAD)) - x),
		height: Math.max(1, Math.min(size.height, Math.ceil(y1 + PAD)) - y),
	};
}

/** Short ticks beside a tile, outside it, at the sides of the measured box, so the box's pixels stay visible. */
function markBox(
	sheet: PNG,
	box: Rect | null,
	area: Rect,
	x: number,
	y: number,
) {
	if (!box) return;
	const put = (px: number, py: number) => {
		if (px >= 0 && py >= 0 && px < sheet.width && py < sheet.height)
			sheet.data.set(MARK, (py * sheet.width + px) * 4);
	};
	for (const [v0, size, along] of [
		[box.x - area.x, box.width, true],
		[box.y - area.y, box.height, false],
	] as const)
		for (const v of [v0, v0 + size - 1]) {
			const p = Math.round(v);
			if (p < 0 || p >= (along ? area.width : area.height)) continue;
			for (let k = 1; k <= TICK; k++)
				for (const d of [0, 1])
					if (along) put(x + p + d, y - k);
					else put(x - k, y + p + d);
		}
}

function crop(src: PNG, r: Rect): PNG {
	const out = new PNG({ width: r.width, height: r.height });
	PNG.bitblt(src, out, r.x, r.y, r.width, r.height, 0, 0);
	return out;
}

/** Id and failing message wrapped to the sheet width; the message is cut with "..." past the line limit. */
function headerLines(row: RowVerdict, width: number): string[] {
	const chars = Math.max(
		8,
		Math.floor((width - 2 * GUTTER) / textWidth("a", TEXT_SCALE)),
	);
	const message = wrapText(row.message, chars);
	if (message.length > MAX_MESSAGE_LINES) {
		message.length = MAX_MESSAGE_LINES;
		const last = message[MAX_MESSAGE_LINES - 1] as string;
		message[MAX_MESSAGE_LINES - 1] = `${last.slice(0, chars - 3)}...`;
	}
	return [row.id.slice(0, chars), ...message];
}

/** One PNG per failing row: a labelled line per moment with reference | clone | diff tiles. */
async function writeSheet(
	row: RowVerdict,
	v: Verdict,
	tracks: { ref: Track; clone: Track; refClip: Rect; cloneClip: Rect },
	outDir: string,
): Promise<SheetInfo> {
	// The moments of the first failures in the message come first; shown in time order.
	const frames = [
		...new Set(row.focusMs.map((t) => nearestFrame(tracks.ref, t))),
	]
		.slice(0, MAX_TIMES)
		.sort((a, b) => a - b);
	const [refFirst, cloneFirst] = await Promise.all([
		readPng(v.referenceDir, frames[0] ?? 0),
		readPng(v.cloneDir, frames[0] ?? 0),
	]);
	const ref: Side = {
		track: tracks.ref,
		clip: tracks.refClip,
		scale: refFirst.width / tracks.refClip.width,
	};
	const clone: Side = {
		track: tracks.clone,
		clip: tracks.cloneClip,
		scale: cloneFirst.width / tracks.cloneClip.width,
	};
	const area = cropFor(row, frames, [ref, clone], {
		width: Math.min(refFirst.width, cloneFirst.width),
		height: Math.min(refFirst.height, cloneFirst.height),
	});
	const width = 3 * area.width + 4 * GUTTER;
	const head = headerLines(row, width);
	const headerHeight = GUTTER + (head.length + 1) * LINE_HEIGHT + GUTTER;
	const rowHeight = LINE_HEIGHT + area.height + GUTTER;
	const sheet = new PNG({
		width,
		height: headerHeight + frames.length * rowHeight,
	});
	for (let i = 0; i < sheet.data.length; i += 4) sheet.data.set(BACKGROUND, i);
	for (const [i, line] of head.entries())
		drawText(
			sheet,
			line,
			GUTTER,
			GUTTER + i * LINE_HEIGHT,
			i === 0 ? INK : MUTED,
			TEXT_SCALE,
		);
	const titleY = GUTTER + head.length * LINE_HEIGHT;
	for (const [col, title] of COLUMN_TITLES.entries()) {
		// Narrow tiles get a half-size title so the three never overlap.
		const scale = textWidth(title, TEXT_SCALE) <= area.width ? TEXT_SCALE : 1;
		drawText(
			sheet,
			title,
			GUTTER + col * (area.width + GUTTER),
			titleY,
			INK,
			scale,
		);
	}
	const tiles: SheetTile[] = [];
	for (const [line, frame] of frames.entries()) {
		const a = crop(await readPng(v.referenceDir, frame), area);
		const b = crop(await readPng(v.cloneDir, frame), area);
		const diff = differenceImage(a, b);
		const rowY = headerHeight + line * rowHeight;
		const y = rowY + LINE_HEIGHT;
		const t = tracks.ref.frames[frame]?.t ?? 0;
		drawText(sheet, `${Math.round(t)} ms`, GUTTER, rowY, INK, TEXT_SCALE);
		for (const [col, [kind, img]] of (
			[
				["reference", a],
				["clone", b],
				["diff", diff],
			] as const
		).entries()) {
			const x = GUTTER + col * (area.width + GUTTER);
			PNG.bitblt(img, sheet, 0, 0, area.width, area.height, x, y);
			if (kind !== "diff")
				markBox(
					sheet,
					boxAt(row, kind === "reference" ? ref : clone, frame),
					area,
					x,
					y,
				);
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
		headerHeight,
		tileWidth: area.width,
		tileHeight: area.height,
		tiles,
	};
}

/**
 * Comparison sheets for failing rows only, each with a JSON sidecar; returns what was written. `cloneTrack` is the
 * clone as verify measured it, with --map names and surface edges; without it the clone's own track.json is read.
 */
export async function writeSheets(
	v: Verdict,
	outDir: string,
	cloneTrack?: Track,
): Promise<SheetInfo[]> {
	const failing = v.rows.filter((r) => !r.pass && r.advisory === null);
	if (v.setupErrors.length > 0 || failing.length === 0) return [];
	await mkdir(outDir, { recursive: true });
	const [ref, clone, refCap, cloneCap] = await Promise.all([
		readTrack(v.referenceDir),
		cloneTrack ?? readTrack(v.cloneDir),
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
