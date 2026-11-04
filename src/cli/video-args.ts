import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { writeContactSheet } from "../video/contact-sheet.ts";
import { captureVideo, probeVideo, type VideoInput } from "../video/index.ts";
import type { Region } from "../video/options.ts";
import { probeScreen, screenLines } from "../video/screen-probe.ts";
import { type CaptureArgs, numbers, UsageError } from "./capture-args.ts";

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".gif"]);
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

// Options that describe a page capture and mean nothing for a recording.
const PAGE_ONLY: (keyof CaptureArgs)[] = [
	"like",
	"viewport",
	"duration",
	"trigger",
	"target",
	"scrollTo",
	"track",
	"clip",
	"selector",
	"pad",
	"preRoll",
	"waitBefore",
	"preJs",
	"preClick",
	"colorScheme",
	"reducedMotion",
	"storageState",
	"cdpUrl",
	"seed",
];
const VIDEO_ONLY: (keyof CaptureArgs)[] = [
	"start",
	"end",
	"crop",
	"width",
	"cssScale",
	"regions",
	"autoRegions",
];

const flagOf = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** True for an existing local video or gif file; throws for a missing path that looks like one. */
export function isVideoInput(input: string): boolean {
	if (!VIDEO_EXT.has(extname(input).toLowerCase()) || URL_LIKE.test(input))
		return false;
	if (!existsSync(input) || !statSync(input).isFile())
		throw new UsageError(`video file not found: ${input}`);
	return true;
}

/** "name=x,y,w,h" in cropped video pixels. */
export function parseRegion(text: string): Omit<Region, "ref"> {
	const eq = text.indexOf("=");
	const name = eq < 0 ? "" : text.slice(0, eq).trim();
	if (!name)
		throw new UsageError(
			`--region "${text}": use name=x,y,w,h, like card[0]=40,60,300,200`,
		);
	const [x, y, w, h] = numbers(
		text.slice(eq + 1),
		4,
		`--region "${text}"`,
		/,/,
	);
	if (
		![x, y, w, h].every(Number.isInteger) ||
		(w as number) < 1 ||
		(h as number) < 1
	)
		throw new UsageError(
			`--region "${text}": x, y, width and height must be whole pixels and the size above 0`,
		);
	return {
		name,
		x: x as number,
		y: y as number,
		w: w as number,
		h: h as number,
	};
}

function videoInput(a: CaptureArgs): VideoInput {
	for (const k of PAGE_ONLY)
		if (a[k] !== undefined)
			throw new UsageError(`--${flagOf(k)} does not apply to video input`);
	if (a.regions?.length && a.autoRegions)
		throw new UsageError("use either --region or --auto-regions, not both");
	let crop: VideoInput["crop"];
	if (a.crop) {
		const [x, y, w, h] = numbers(a.crop, 4, "--crop", /,/);
		crop = { x: x as number, y: y as number, w: w as number, h: h as number };
	}
	return {
		input: resolve(a.url),
		outDir: a.out,
		start: a.start,
		end: a.end,
		fps: a.fps,
		crop,
		width: a.width,
		cssScale: a.cssScale,
		regions: a.regions?.length
			? a.regions.map((r) => parseRegion(r))
			: undefined,
	};
}

export function assertNoVideoFlags(a: CaptureArgs): void {
	for (const k of VIDEO_ONLY)
		if (a[k] !== undefined)
			throw new UsageError(`--${flagOf(k)} only applies to video input`);
}

/** Capture a video or gif and describe the result in lines. */
export async function runVideoCapture(a: CaptureArgs): Promise<string[]> {
	const s = await captureVideo(videoInput(a));
	return [
		`captured ${s.frames} frames (${s.frameMs.toFixed(1)} ms each, ${s.fps} fps) to ${s.outDir}`,
		...s.regions.map(
			(r) =>
				`region ${r.name}: x ${r.box.x} y ${r.box.y} ${r.box.w}x${r.box.h} CSS px, found in ${r.foundFrames}/${s.frames} frames`,
		),
		...s.warnings.map((w) => `warning: ${w}`),
	];
}

export interface ProbeArgs {
	/** Print the screen guess even when unsure. */
	screen?: boolean;
	/** Directory for contact-sheet.png. */
	sheet?: string;
	/** Contact sheet interval in ms. */
	every?: number;
}

/** Size, rate, duration and codec, then the device screen, the motion windows and an optional contact sheet. */
export async function probeLines(
	file: string,
	a: ProbeArgs = {},
): Promise<string[]> {
	const path = resolve(file);
	if (!existsSync(path) || !statSync(path).isFile())
		throw new UsageError(`file not found: ${file}`);
	if (a.every !== undefined && !(a.every > 0))
		throw new UsageError("--every must be above 0 ms");
	const p = await probeVideo(path);
	const s = await probeScreen(path, p);
	const lines = [
		`file: ${p.path}`,
		`size: ${p.width}x${p.height}`,
		`fps: ${p.fps}${p.fpsFromFrames ? " (measured from frame timestamps)" : ""}`,
		`duration: ${p.durationS === null ? "unknown" : `${p.durationS.toFixed(3)} s`}`,
		`codec: ${p.codec}`,
		...screenLines(s, p, a.screen ?? false),
	];
	if (a.sheet) {
		const sheet = await writeContactSheet(path, p, a.sheet, {
			everyMs: a.every,
			crop: s.crop ?? undefined,
		});
		lines.push(
			`contact sheet: ${sheet.png} (${sheet.tiles.length} frames, every ${sheet.everyMs} ms${s.crop ? ", cropped to the screen" : ""})`,
		);
	}
	return lines;
}
