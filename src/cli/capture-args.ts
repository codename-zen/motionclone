import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { z } from "zod";
import { type CaptureInput, captureMotion } from "../capture/index.ts";
import type { CaptureSummary } from "../capture/types.ts";
import { type CaptureFile, readCaptureFile } from "../spec/capture-file.ts";
import { isVideoCapture } from "../verify/setup.ts";
import { framePng } from "../video/luma.ts";
import { dragPathOf } from "./drag-path.ts";
import { UsageError } from "./usage-error.ts";

export { dragPathOf, UsageError };

/** Flat capture arguments shared by the CLI flags and the MCP capture tool. */
export const CaptureArgs = z.object({
	url: z.string().min(1).describe("URL or local path of the page to capture"),
	out: z.string().min(1).describe("Directory for the capture"),
	like: z
		.string()
		.optional()
		.describe(
			"Reference capture directory: reuse all its options except url and out; for a video capture, its fps, duration and screen size",
		),
	viewport: z.string().optional().describe("WIDTHxHEIGHT, default 1280x800"),
	fps: z.number().optional().describe("Frames per second, default 60"),
	duration: z
		.number()
		.optional()
		.describe("Capture length in ms after the trigger"),
	trigger: z
		.enum(["load", "none", "hover", "leave", "click", "scroll", "drag"])
		.optional()
		.describe("What starts the motion, default load"),
	target: z
		.string()
		.optional()
		.describe("CSS selector for hover, leave, click and drag"),
	scrollTo: z
		.string()
		.optional()
		.describe("Scroll trigger destination: pixels or a CSS selector"),
	drag: z
		.string()
		.optional()
		.describe(
			'Drag trigger path: points "x,y@ms" separated by spaces, CSS px from the centre of the target and ms after the trigger; the pointer goes down at the first point, moves on every frame and goes up at the last, e.g. "0,0@500 0,300@1300"',
		),
	track: z
		.array(z.string())
		.optional()
		.describe("CSS selectors whose elements are tracked every frame"),
	clip: z.string().optional().describe("Crop as x,y,width,height"),
	selector: z.string().optional().describe("Crop around this element"),
	pad: z.number().optional().describe("Padding in px for the selector crop"),
	preRoll: z
		.number()
		.optional()
		.describe("Idle ms recorded before the trigger"),
	waitBefore: z
		.number()
		.optional()
		.describe("Idle ms before the trigger fires"),
	preJs: z
		.string()
		.optional()
		.describe(
			"JavaScript run in the page after load and before the trigger (statements and await allowed), e.g. to dismiss a cookie banner",
		),
	preClick: z
		.array(z.string())
		.optional()
		.describe(
			"CSS selectors clicked in order before the trigger; a selector that matches nothing is skipped with a warning",
		),
	colorScheme: z.enum(["light", "dark", "no-preference"]).optional(),
	reducedMotion: z
		.boolean()
		.optional()
		.describe("Emulate prefers-reduced-motion"),
	storageState: z.string().optional().describe("Playwright storage state file"),
	cdpUrl: z.string().optional().describe("Attach to a running Chrome over CDP"),
	seed: z.number().int().optional().describe("Math.random seed, default 1"),
	start: z
		.union([z.string(), z.number()])
		.optional()
		.describe("Video input: start time, seconds or 1500ms or m:ss.s"),
	end: z
		.union([z.string(), z.number()])
		.optional()
		.describe("Video input: end time, default the last frame"),
	crop: z
		.string()
		.optional()
		.describe("Video input: crop as x,y,w,h in video pixels"),
	width: z
		.number()
		.optional()
		.describe("Video input: scale the cropped frames to this width"),
	cssScale: z
		.number()
		.optional()
		.describe("Video input: video pixels per CSS pixel, 2 for a 2x screen"),
	regions: z
		.array(z.string())
		.optional()
		.describe(
			'Video input: elements to track as "name=x,y,w,h" in cropped video pixels; name card[0], card[1] makes an indexed group',
		),
	autoRegions: z
		.boolean()
		.optional()
		.describe("Video input: find moving blobs automatically (the default)"),
});
export type CaptureArgs = z.infer<typeof CaptureArgs>;

/** A path to an existing .js file is read; anything else is the code itself. */
export function preJsOf(value: string | undefined): string | undefined {
	if (value && /.m?js$/i.test(value) && existsSync(value))
		return readFileSync(value, "utf8");
	return value;
}

export function numbers(
	text: string,
	count: number,
	flag: string,
	sep: RegExp,
) {
	const parts = text.split(sep).map((p) => Number(p.trim()));
	if (parts.length !== count || parts.some((n) => !Number.isFinite(n)))
		throw new UsageError(`${flag}: cannot read "${text}"`);
	return parts as number[];
}

function triggerOf(a: CaptureArgs): CaptureInput["trigger"] | undefined {
	if (!a.trigger) return undefined;
	if (a.trigger === "drag") {
		if (!a.target || !a.drag)
			throw new UsageError("--trigger drag needs --target and --drag");
		return { type: "drag", target: a.target, path: dragPathOf(a.drag) };
	}
	if (a.trigger === "scroll") {
		if (a.scrollTo === undefined)
			throw new UsageError("--trigger scroll needs --scroll-to");
		const px = Number(a.scrollTo);
		return Number.isFinite(px) && a.scrollTo.trim() !== ""
			? { type: "scroll", toPx: px }
			: { type: "scroll", toSelector: a.scrollTo };
	}
	if (a.trigger === "load" || a.trigger === "none") return { type: a.trigger };
	if (!a.target) throw new UsageError(`--trigger ${a.trigger} needs --target`);
	return { type: a.trigger, target: a.target };
}

function clipOf(a: CaptureArgs): CaptureInput["clip"] | undefined {
	if (a.clip && a.selector)
		throw new UsageError("use either --clip or --selector, not both");
	if (a.clip) {
		const [x, y, width, height] = numbers(a.clip, 4, "--clip", /,/);
		return {
			x: x as number,
			y: y as number,
			width: width as number,
			height: height as number,
		};
	}
	if (a.selector)
		return {
			selector: a.selector,
			...(a.pad === undefined ? {} : { pad: a.pad }),
		};
	return undefined;
}

const defined = <T extends object>(o: T): Partial<T> =>
	Object.fromEntries(
		Object.entries(o).filter(([, v]) => v !== undefined),
	) as Partial<T>;

interface VideoSection {
	crop: { w: number; h: number };
	scale: number;
	cssScale: number;
	frameSize: { width: number; height: number };
}

/**
 * The base for a clone of a recording: its fps and duration with a load trigger, and the screen it shows, so
 * clone frames have the reference frames' pixel size: the frames in CSS pixels as the viewport, and frame
 * pixels per CSS pixel as the device scale factor.
 */
function likeVideo(dir: string, ref: CaptureFile): Partial<CaptureInput> {
	const v = (ref as CaptureFile & { video: VideoSection }).video;
	const deviceScaleFactor = v.scale * v.cssScale;
	const viewport = {
		width: Math.max(1, Math.round(v.frameSize.width / deviceScaleFactor)),
		height: Math.max(1, Math.round(v.frameSize.height / deviceScaleFactor)),
	};
	return {
		fps: ref.options.fps,
		durationMs: ref.options.durationMs,
		trigger: { type: "load" },
		preRollMs: 0,
		viewport,
		deviceScaleFactor,
		likeVideo: {
			capture: resolve(dir),
			crop: { w: v.crop.w, h: v.crop.h },
			cssScale: v.cssScale,
			scale: v.scale,
			frameSize: v.frameSize,
			viewport,
			deviceScaleFactor,
		},
	};
}

/** CaptureOptions input from flat args; with `like`, the reference's options are the base. */
export async function buildCaptureInput(a: CaptureArgs): Promise<CaptureInput> {
	let base: Partial<CaptureInput> = {};
	if (a.like) {
		let ref: CaptureFile;
		try {
			ref = await readCaptureFile(a.like);
		} catch {
			throw new UsageError(`--like: no capture.json in ${a.like}`);
		}
		const { likeVideo: _, ...options } = ref.options;
		base = isVideoCapture(ref) ? likeVideo(a.like, ref) : options;
	}
	let viewport: CaptureInput["viewport"];
	if (a.viewport) {
		const [width, height] = numbers(a.viewport, 2, "--viewport", /x/i);
		viewport = { width: width as number, height: height as number };
	}
	const input = {
		...base,
		...defined({
			viewport,
			fps: a.fps,
			durationMs: a.duration,
			trigger: triggerOf(a),
			track: a.track,
			clip: clipOf(a),
			preRollMs: a.preRoll,
			waitBeforeMs: a.waitBefore,
			preJs: a.preJs,
			preClick: a.preClick,
			colorScheme: a.colorScheme,
			reducedMotion: a.reducedMotion ? "reduce" : undefined,
			storageState: a.storageState,
			cdpUrl: a.cdpUrl,
			seed: a.seed,
		}),
		url: a.url,
		outDir: a.out,
	};
	if (input.durationMs === undefined)
		throw new UsageError("--duration <ms> is required (or --like)");
	return input as CaptureInput;
}

/** A clone of a recording must have the reference frames' pixel size; frames that differ are named in a warning. */
async function checkLikeVideoSize(
	input: CaptureInput,
	s: CaptureSummary,
): Promise<void> {
	const like = input.likeVideo;
	const want = like?.frameSize;
	const vp = input.viewport;
	if (!like || !want || s.frames === 0) return;
	if (
		vp &&
		(vp.width !== like.viewport.width || vp.height !== like.viewport.height)
	)
		return;
	const png = PNG.sync.read(await readFile(framePng(s.outDir, 0)));
	if (png.width !== want.width || png.height !== want.height)
		s.warnings.push(
			`clone frames are ${png.width}x${png.height} px but the reference frames are ${want.width}x${want.height} px: capture the reference again (its crop is now trimmed to whole CSS pixels) or pass --viewport`,
		);
}

export async function runCapture(a: CaptureArgs): Promise<CaptureSummary> {
	const input = await buildCaptureInput(a);
	const s = await captureMotion(input);
	await checkLikeVideoSize(input, s);
	return s;
}
