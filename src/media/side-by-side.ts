import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { drawText, GLYPH_HEIGHT, textWidth } from "../report/font.ts";
import {
	type Clip,
	FrameReader,
	firstTime,
	frameAt,
	lastTime,
	readClip,
} from "./clip.ts";
import { encodeFrames, GIF_WARN_BYTES } from "./encode.ts";
import {
	blank,
	crop,
	fitInto,
	parseRect,
	type Rect,
	type Rgb,
} from "./image.ts";
import { readVerdictLabel, type VerdictLabel } from "./verdict-label.ts";

export interface SideBySideOptions {
	/** Reference capture directory first, then one or more clone directories. */
	dirs: string[];
	out: string;
	labels?: string[];
	fromMs?: number;
	toMs?: number;
	fps?: number;
	/** Largest width of the whole picture, default 1280. */
	width?: number;
	/** One rectangle for every input, or one per input; "-" or "" keeps the whole frame. */
	crop?: string[];
	/** Per input: ms into that capture that lines up with the others' t=0. */
	offsets?: number[];
	/** Shows the last frame this long before the loop restarts. */
	holdMs?: number;
}

export interface SideBySideResult {
	out: string;
	frames: number;
	width: number;
	height: number;
	fps: number;
	bytes: number;
	warnings: string[];
}

const BACKGROUND: Rgb = [24, 24, 28];
const PANEL: Rgb = [0, 0, 0];
const INK: Rgb = [235, 235, 240];
const GAP = 12;
const DEFAULT_WIDTH = 1280;
const MAX_FRAMES = 900;

const defaultLabel = (i: number, count: number) =>
	i === 0 ? "Reference" : count > 2 ? `Rebuild ${i}` : "Rebuild";

function cropsFor(spec: string[] | undefined, count: number): (Rect | null)[] {
	const list = (spec ?? []).map((s) =>
		s.trim() === "" || s.trim() === "-" ? null : parseRect(s),
	);
	if (list.length > 1 && list.length !== count)
		throw new Error(
			`crop: give one rectangle for all inputs or ${count}, got ${list.length}`,
		);
	return Array.from({ length: count }, (_, i) =>
		list.length === 1 ? (list[0] ?? null) : (list[i] ?? null),
	);
}

function truncate(text: string, maxWidth: number, scale: number): string {
	let t = text;
	while (t.length > 1 && textWidth(t, scale) > maxWidth) t = t.slice(0, -1);
	return t;
}

interface Layout {
	panelW: number;
	panelH: number;
	scale: number;
	header: number;
	width: number;
	height: number;
}

function layout(
	sizes: { width: number; height: number }[],
	lines: number,
	maxWidth: number,
): Layout {
	const h0 = (sizes[0] as { height: number }).height;
	const natural = Math.max(
		...sizes.map((s) => Math.round((s.width * h0) / s.height)),
	);
	const n = sizes.length;
	const k = Math.min(1, (maxWidth - (n + 1) * GAP) / (n * natural));
	const panelW = Math.max(16, Math.round(natural * k));
	const panelH = Math.max(16, Math.round(h0 * k));
	const scale = Math.max(1, Math.min(3, Math.floor(panelW / 160)));
	const line = GLYPH_HEIGHT * scale + 6;
	const header = GAP + lines * line;
	const even = (v: number) => v + (v % 2);
	return {
		panelW,
		panelH,
		scale,
		header,
		width: even(n * panelW + (n + 1) * GAP),
		height: even(header + panelH + GAP),
	};
}

function drawHeader(
	canvas: PNG,
	l: Layout,
	labels: string[],
	verdicts: (VerdictLabel | null)[],
): void {
	const line = GLYPH_HEIGHT * l.scale + 6;
	labels.forEach((label, i) => {
		const x = GAP + i * (l.panelW + GAP);
		drawText(canvas, truncate(label, l.panelW, l.scale), x, GAP, INK, l.scale);
		const v = verdicts[i];
		if (v)
			drawText(
				canvas,
				truncate(v.text, l.panelW, l.scale),
				x,
				GAP + line,
				v.color,
				l.scale,
			);
	});
}

/** Compose capture directories into one labelled side-by-side GIF or MP4. */
export async function sideBySide(
	o: SideBySideOptions,
): Promise<SideBySideResult> {
	if (o.dirs.length < 2)
		throw new Error("need a reference and at least one clone directory");
	if (!/\.(gif|mp4)$/i.test(o.out))
		throw new Error("--out must end in .gif or .mp4");
	const n = o.dirs.length;
	const clips: Clip[] = await Promise.all(
		o.dirs.map((d) => readClip(resolve(d))),
	);
	const readers = clips.map((c) => new FrameReader(c));
	const crops = cropsFor(o.crop, n);
	const offsets = Array.from({ length: n }, (_, i) => o.offsets?.[i] ?? 0);
	const verdicts = await Promise.all(
		clips.map((c, i) => (i === 0 ? null : readVerdictLabel(c.dir))),
	);
	const labels = Array.from(
		{ length: n },
		(_, i) => o.labels?.[i]?.trim() || defaultLabel(i, n),
	);

	const firsts = await Promise.all(readers.map((r) => r.read(0)));
	const sizes = firsts.map((p, i) => {
		const c = crops[i];
		const cut = c ? crop(p, c) : p;
		return { width: cut.width, height: cut.height };
	});
	const l = layout(
		sizes,
		verdicts.some(Boolean) ? 2 : 1,
		o.width ?? DEFAULT_WIDTH,
	);

	const from =
		o.fromMs ??
		Math.max(...clips.map((c, i) => firstTime(c) - (offsets[i] as number)));
	const to =
		o.toMs ??
		Math.min(...clips.map((c, i) => lastTime(c) - (offsets[i] as number)));
	if (!(to > from)) throw new Error(`empty time range: ${from} to ${to} ms`);
	const fps =
		o.fps ?? Math.min(30, Math.round(1000 / (clips[0] as Clip).frameMs));
	const step = 1000 / fps;
	const count = Math.floor((to - from) / step + 1e-9) + 1;
	const hold = Math.max(0, Math.round((o.holdMs ?? 0) / step));
	if (count + hold > MAX_FRAMES)
		throw new Error(
			`${count} frames is too many (limit ${MAX_FRAMES}); narrow --from/--to or lower --fps`,
		);

	const warnings: string[] = [];
	for (const [i, c] of clips.entries()) {
		const off = offsets[i] as number;
		if (from + off < firstTime(c) - 1e-6 || to + off > lastTime(c) + 1e-6)
			warnings.push(
				`${labels[i]}: time range is outside its capture, edge frames repeat`,
			);
	}

	const tmp = await mkdtemp(join(tmpdir(), "motionclone-sbs-"));
	try {
		for (let k = 0; k < count; k++) {
			const t = from + k * step;
			const canvas = blank(l.width, l.height, BACKGROUND);
			drawHeader(canvas, l, labels, verdicts);
			for (const [i, r] of readers.entries()) {
				const src = await r.read(frameAt(r.clip, t + (offsets[i] as number)));
				const c = crops[i];
				const tile = fitInto(c ? crop(src, c) : src, l.panelW, l.panelH, PANEL);
				PNG.bitblt(
					tile,
					canvas,
					0,
					0,
					l.panelW,
					l.panelH,
					GAP + i * (l.panelW + GAP),
					l.header,
				);
			}
			const png = PNG.sync.write(canvas);
			await writeFile(join(tmp, `${String(k).padStart(5, "0")}.png`), png);
			if (k === count - 1)
				for (let h = 1; h <= hold; h++)
					await writeFile(
						join(tmp, `${String(k + h).padStart(5, "0")}.png`),
						png,
					);
		}
		const out = resolve(o.out);
		await mkdir(dirname(out), { recursive: true });
		const bytes = await encodeFrames(tmp, fps, out);
		if (out.toLowerCase().endsWith(".gif") && bytes > GIF_WARN_BYTES)
			warnings.push(
				`gif is ${(bytes / 1048576).toFixed(1)} MB; lower --width or --fps, narrow --from/--to, or write .mp4`,
			);
		return {
			out,
			frames: count + hold,
			width: l.width,
			height: l.height,
			fps,
			bytes,
			warnings,
		};
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}
