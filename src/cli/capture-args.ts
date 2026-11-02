import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { type CaptureInput, captureMotion } from "../capture/index.ts";
import type { CaptureSummary } from "../capture/types.ts";
import { readCaptureFile } from "../spec/capture-file.ts";
import { isVideoCapture } from "../verify/setup.ts";

export class UsageError extends Error {}

/** Flat capture arguments shared by the CLI flags and the MCP capture tool. */
export const CaptureArgs = z.object({
	url: z.string().min(1).describe("URL or local path of the page to capture"),
	out: z.string().min(1).describe("Directory for the capture"),
	like: z
		.string()
		.optional()
		.describe(
			"Reference capture directory: reuse all its options except url and out",
		),
	viewport: z.string().optional().describe("WIDTHxHEIGHT, default 1280x800"),
	fps: z.number().optional().describe("Frames per second, default 60"),
	duration: z
		.number()
		.optional()
		.describe("Capture length in ms after the trigger"),
	trigger: z
		.enum(["load", "none", "hover", "leave", "click", "scroll"])
		.optional()
		.describe("What starts the motion, default load"),
	target: z
		.string()
		.optional()
		.describe("CSS selector for hover, leave and click"),
	scrollTo: z
		.string()
		.optional()
		.describe("Scroll trigger destination: pixels or a CSS selector"),
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

/** CaptureOptions input from flat args; with `like`, the reference's options are the base. */
export async function buildCaptureInput(a: CaptureArgs): Promise<CaptureInput> {
	let base: Partial<CaptureInput> = {};
	if (a.like) {
		let ref: Awaited<ReturnType<typeof readCaptureFile>>;
		try {
			ref = await readCaptureFile(a.like);
		} catch {
			throw new UsageError(`--like: no capture.json in ${a.like}`);
		}
		// A recording has no page viewport, scale or seed: take what the clone must match.
		base = isVideoCapture(ref)
			? {
					fps: ref.options.fps,
					durationMs: ref.options.durationMs,
					trigger: { type: "load" },
					preRollMs: 0,
				}
			: { ...ref.options };
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

export async function runCapture(a: CaptureArgs): Promise<CaptureSummary> {
	return captureMotion(await buildCaptureInput(a));
}
