import { z } from "zod";

const Rect = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number().positive(),
	height: z.number().positive(),
});

/** A point of a drag path: CSS px from the target's centre, ms after the trigger. */
export const DragPoint = z.object({
	x: z.number(),
	y: z.number(),
	atMs: z.number().nonnegative(),
});

export const Trigger = z.discriminatedUnion("type", [
	z.object({ type: z.literal("load") }),
	z.object({ type: z.literal("none") }),
	z.object({
		type: z.literal("hover"),
		target: z.string(),
		at: z.object({ x: z.number(), y: z.number() }).optional(),
	}),
	z.object({ type: z.literal("leave"), target: z.string() }),
	z.object({ type: z.literal("click"), target: z.string() }),
	// Press at the first point, move through the others on every frame, release at the last.
	z.object({
		type: z.literal("drag"),
		target: z.string(),
		path: z
			.array(DragPoint)
			.min(2)
			.refine(
				(p) => p.every((q, i) => i === 0 || q.atMs > (p[i - 1]?.atMs ?? 0)),
				{
					message: "drag path times must increase from point to point",
				},
			),
	}),
	z
		.object({
			type: z.literal("scroll"),
			toPx: z.number().optional(),
			toSelector: z.string().optional(),
			steps: z.number().int().positive().default(10),
			ms: z.number().nonnegative().default(300),
		})
		.refine((s) => (s.toPx === undefined) !== (s.toSelector === undefined), {
			message: "scroll needs exactly one of toPx or toSelector",
		}),
]);

export const CaptureOptions = z.object({
	url: z.string().min(1),
	outDir: z.string().min(1),
	viewport: z
		.object({
			width: z.number().int().positive(),
			height: z.number().int().positive(),
		})
		.default({ width: 1280, height: 800 }),
	deviceScaleFactor: z.number().positive().default(1),
	trigger: Trigger.default({ type: "load" }),
	// Optional so load captures can tell an explicit value (warned, ignored) from the default.
	preRollMs: z.number().nonnegative().optional(),
	waitBeforeMs: z.number().nonnegative().optional(),
	preJs: z.string().min(1).optional(),
	preClick: z.array(z.string().min(1)).default([]),
	durationMs: z.number().positive(),
	fps: z.number().positive().max(240).default(60),
	track: z.array(z.string().min(1)).default([]),
	clip: z
		.union([
			Rect,
			z.object({
				selector: z.string(),
				pad: z.number().nonnegative().default(16),
			}),
		])
		.optional(),
	colorScheme: z.enum(["light", "dark", "no-preference"]).optional(),
	reducedMotion: z.enum(["reduce", "no-preference"]).optional(),
	storageState: z.string().optional(),
	cdpUrl: z.string().optional(),
	seed: z.number().int().default(1),
	/** Set by --like on a video capture: the recording's geometry the viewport and scale were derived from. */
	likeVideo: z
		.object({
			capture: z.string(),
			crop: z.object({ w: z.number(), h: z.number() }),
			cssScale: z.number(),
			scale: z.number(),
			frameSize: z.object({ width: z.number(), height: z.number() }),
			viewport: z.object({ width: z.number(), height: z.number() }),
			deviceScaleFactor: z.number(),
		})
		.optional(),
});

export type CaptureInput = z.input<typeof CaptureOptions>;
export type CaptureOptions = z.output<typeof CaptureOptions>;
export type TriggerOptions = z.output<typeof Trigger>;
export type ClipRect = z.output<typeof Rect>;
export type DragPoint = z.output<typeof DragPoint>;

export const DEFAULT_PRE_ROLL_MS = 200;
export const DEFAULT_WAIT_BEFORE_MS = 500;
