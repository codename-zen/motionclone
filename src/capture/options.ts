import { z } from "zod";

const Rect = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number().positive(),
	height: z.number().positive(),
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
});

export type CaptureInput = z.input<typeof CaptureOptions>;
export type CaptureOptions = z.output<typeof CaptureOptions>;
export type TriggerOptions = z.output<typeof Trigger>;
export type ClipRect = z.output<typeof Rect>;

export const DEFAULT_PRE_ROLL_MS = 200;
export const DEFAULT_WAIT_BEFORE_MS = 500;
