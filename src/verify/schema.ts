import { z } from "zod";

export const VERDICT_VERSION = 1;

export const Metric = z.object({
	want: z.number().nullable(),
	got: z.number().nullable(),
	/** got - want, or a relative error for distance, or the deviation for easing. */
	diff: z.number().nullable(),
	tol: z.number().nullable(),
	unit: z.string(),
	pass: z.boolean(),
});

export const RowVerdict = z.object({
	id: z.string(),
	kind: z.enum(["motion", "still"]),
	selector: z.string(),
	index: z.number().int(),
	property: z.string().nullable(),
	pass: z.boolean(),
	metrics: z.record(z.string(), Metric),
	/** One instruction-like sentence per failing check, element and numbers included. */
	failures: z.array(z.string()),
	message: z.string(),
	/** Trigger-relative times worth looking at for this row. */
	focusMs: z.array(z.number()),
});

export const PixelFrame = z.object({
	frame: z.number().int(),
	t: z.number(),
	mismatch: z.number(),
	ssim: z.number(),
});

export const PixelResult = z.object({
	frames: z.array(PixelFrame),
	meanMismatch: z.number().nullable(),
	meanSsim: z.number().nullable(),
	threshold: z.number(),
	enforced: z.boolean(),
	pass: z.boolean(),
	skipped: z.string().nullable(),
});

export const Guardrail = z.object({
	rule: z.enum(["layout-property", "ease-in-entrance", "reduced-motion"]),
	target: z.string(),
	message: z.string(),
});

export const Verdict = z.object({
	version: z.literal(VERDICT_VERSION),
	referenceDir: z.string(),
	cloneDir: z.string(),
	fidelity: z.enum(["motion", "pixel"]),
	setupErrors: z.array(z.string()),
	rows: z.array(RowVerdict),
	pixel: PixelResult.nullable(),
	warnings: z.array(Guardrail),
	summary: z.object({
		rows: z.number().int(),
		passed: z.number().int(),
		failed: z.number().int(),
	}),
	pass: z.boolean(),
});

export type Metric = z.output<typeof Metric>;
export type RowVerdict = z.output<typeof RowVerdict>;
export type PixelFrame = z.output<typeof PixelFrame>;
export type PixelResult = z.output<typeof PixelResult>;
export type Guardrail = z.output<typeof Guardrail>;
export type Verdict = z.output<typeof Verdict>;
