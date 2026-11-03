import { z } from "zod";
import { Trigger } from "../capture/options.ts";
import { PROPERTIES } from "../measure/series.ts";

export const SPEC_VERSION = 1;
export const PROGRESS = "progress";

export const DEFAULT_TOLERANCES = {
	startMs: 80,
	endMs: 80,
	durationMs: 80,
	staggerMs: 40,
	easing: 0.05,
	distance: 0.1,
	overshootPp: 5,
} as const;

const ms = z.number().nonnegative();

/** Timing tolerances are widened to one frame at verify time. */
export const Tolerances = z.object({
	startMs: ms.default(DEFAULT_TOLERANCES.startMs),
	endMs: ms.default(DEFAULT_TOLERANCES.endMs),
	durationMs: ms.default(DEFAULT_TOLERANCES.durationMs),
	staggerMs: ms.default(DEFAULT_TOLERANCES.staggerMs),
	/** Largest gap between the clone's progress and the spec curve, 0..1. */
	easing: z.number().nonnegative().default(DEFAULT_TOLERANCES.easing),
	/** Relative distance error, 0.1 = 10 %. */
	distance: z.number().nonnegative().default(DEFAULT_TOLERANCES.distance),
	/** Overshoot difference in percentage points of the change. */
	overshootPp: z.number().nonnegative().default(DEFAULT_TOLERANCES.overshootPp),
});

const Bezier = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const Easing = z.discriminatedUnion("type", [
	z.object({ type: z.literal("linear") }),
	z.object({
		type: z.literal("cubic-bezier"),
		p: Bezier,
		/** Named preset with these exact control points, if any. */
		name: z.string().nullable(),
		aliases: z.array(z.string()).default([]),
	}),
	z.object({
		type: z.literal("spring"),
		stiffness: z.number().positive(),
		damping: z.number().nonnegative(),
		mass: z.number().positive(),
		zeta: z.number().nonnegative(),
		/** 2 % band settle time. */
		settleMs: ms,
		cssLinear: z.object({ css: z.string(), durationMs: ms }),
	}),
	z.object({
		type: z.literal("steps"),
		count: z.number().int().positive(),
		position: z.enum(["start", "end"]),
	}),
]);

export const SpecRow = z.object({
	id: z.string(),
	selector: z.string(),
	index: z.number().int().nonnegative(),
	/** A tracked property, or `progress`: appearance in the element's box from pixels, 0 to 1 (ADR 0005). */
	property: z.enum([...PROPERTIES, PROGRESS]),
	from: z.number(),
	to: z.number(),
	/** False when the reference never shows the start value: `from` is extrapolated and verify checks the clone against the visible readings. */
	fromObserved: z.boolean().default(true),
	/** Trigger-relative ms. */
	startMs: z.number(),
	durationMs: ms,
	easing: Easing,
	/** Largest excursion past `to`, as a fraction of the change. */
	overshoot: z.number().nonnegative(),
	/** Distance divided by the element size along the motion axis; null when the property has no axis. */
	relativeDistance: z.number().nullable(),
	source: z.enum(["declared", "measured"]),
	/** From `support` (ADR 0003); verify reports "low" rows as advisory, never as failures. */
	confidence: z.enum(["high", "medium", "low"]),
	/** The evidence behind `confidence`; null in spec files drafted before it existed. */
	support: z
		.object({
			/** Plain readings inside the motion, without bounds or low-quality frames. */
			samples: z.number().int().nonnegative(),
			rmse: z.number().nonnegative(),
			/** Share of the change the reference shows, 0..1. */
			observed: z.number().min(0).max(1),
			/** Mean tracker match quality inside the motion, when the tracker reports one. */
			quality: z.number().min(0).max(1).nullable(),
			/** Why the evidence is weak, one reason per failed check. */
			weak: z.array(z.string()),
		})
		.nullable()
		.default(null),
	/** Fit error of the spec curve against the reference track, in progress units. */
	rmse: z.number().nonnegative(),
	/** Largest deviation of the reference itself from `easing` (timing fitted freely); verify allows this on top of the easing tolerance. */
	easingResidual: z.number().nonnegative().default(0),
	/** Start gap to the previous index of the same selector and property. */
	stagger: z.object({ after: z.string(), gapMs: z.number() }).nullable(),
	tolerances: Tolerances.prefault({}),
	notes: z.array(z.string()).default([]),
});

export const StillEntry = z.object({
	id: z.string(),
	selector: z.string(),
	index: z.number().int().nonnegative(),
	notes: z.array(z.string()).default([]),
});

export const SpecMeta = z.object({
	tool: z.string(),
	referenceDir: z.string(),
	url: z.string(),
	viewport: z.object({
		width: z.number().int().positive(),
		height: z.number().int().positive(),
	}),
	trigger: Trigger,
	fps: z.number().positive(),
	frameMs: z.number().positive(),
	durationMs: z.number().positive(),
	seed: z.number().int(),
	track: z.array(z.string()),
	reducedMotion: z.enum(["reduce", "no-preference"]).optional(),
	colorScheme: z.enum(["light", "dark", "no-preference"]).optional(),
	stack: z.array(z.string()),
});

export const SpecFile = z.object({
	version: z.literal(SPEC_VERSION),
	meta: SpecMeta,
	rows: z.array(SpecRow),
	still: z.array(StillEntry),
});

export type Easing = z.output<typeof Easing>;
export type Tolerances = z.output<typeof Tolerances>;
export type SpecRow = z.output<typeof SpecRow>;
export type StillEntry = z.output<typeof StillEntry>;
export type SpecMeta = z.output<typeof SpecMeta>;
export type SpecFile = z.output<typeof SpecFile>;
