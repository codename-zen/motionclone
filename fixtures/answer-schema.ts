import { z } from "zod";

export const Easing = z.discriminatedUnion("type", [
	z.object({ type: z.literal("linear") }),
	z.object({
		type: z.literal("cubic-bezier"),
		p: z.tuple([z.number(), z.number(), z.number(), z.number()]),
	}),
	z.object({
		type: z.literal("spring"),
		stiffness: z.number(),
		damping: z.number(),
		mass: z.number(),
	}),
	z.object({
		type: z.literal("steps"),
		count: z.number().int(),
		position: z.enum(["start", "end"]),
	}),
]);

export const Trigger = z.discriminatedUnion("type", [
	z.object({ type: z.literal("load") }),
	z.object({ type: z.literal("none") }),
	z.object({ type: z.literal("hover"), target: z.string() }),
	z.object({ type: z.literal("leave"), target: z.string() }),
	z.object({ type: z.literal("click"), target: z.string() }),
	z.object({ type: z.literal("scroll"), toPx: z.number() }),
]);

export const AnswerRow = z.object({
	selector: z.string(),
	index: z.number().int().nonnegative(),
	property: z.enum([
		"opacity",
		"translateX",
		"translateY",
		"scale",
		"rotate",
		"width",
		"height",
		"blur",
		"clipPath",
		"backgroundColor",
	]),
	from: z.union([z.number(), z.string()]),
	to: z.union([z.number(), z.string()]),
	startMs: z.number(),
	durationMs: z.number().positive(),
	easing: Easing,
	iterations: z
		.union([z.number().positive(), z.literal("infinite")])
		.default(1),
	source: z.enum([
		"css-animation",
		"css-transition",
		"waapi",
		"gsap",
		"motion",
	]),
	scrollLinked: z.object({ startPx: z.number(), endPx: z.number() }).optional(),
});

export const Answer = z.object({
	name: z.string(),
	description: z.string(),
	viewport: z.object({ width: z.number().int(), height: z.number().int() }),
	trigger: Trigger,
	captureMs: z.number().positive(),
	rows: z.array(AnswerRow).min(1),
});

export type Answer = z.infer<typeof Answer>;
export type AnswerRow = z.infer<typeof AnswerRow>;
