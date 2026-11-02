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
	/** What this verdict checked differently, such as a row whose start the reference does not show. */
	notes: z.array(z.string()).default([]),
	/** Why the spec row's evidence is weak, for a low-confidence row: it is reported but never fails the verdict. */
	advisory: z.string().nullable().default(null),
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

export const CoverageElement = z.object({
	id: z.string(),
	selector: z.string(),
	index: z.number().int(),
	/** Properties with a spec row for this element. */
	rows: z.array(z.string()),
	/** Properties this source can turn into rows. */
	measured: z.array(z.string()),
	/** Visible properties this source cannot measure. */
	notMeasured: z.array(z.string()),
});

export const CoverageWarning = z.object({
	rule: z.enum([
		"unexplained-change",
		"untracked-motion",
		"unmeasured-property",
	]),
	/** Element key, or "untracked". */
	target: z.string(),
	fromMs: z.number(),
	toMs: z.number(),
	message: z.string(),
});

/** What a passing verdict does not cover; warnings never fail the verdict. */
export const Coverage = z.object({
	source: z.enum(["page", "video"]),
	elements: z.array(CoverageElement),
	warnings: z.array(CoverageWarning),
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
	/** Null when setup errors stopped the comparison. */
	coverage: Coverage.nullable().default(null),
	/** `passed` and `failed` count checked rows; `advisory` rows are reported apart and never fail. */
	summary: z.object({
		rows: z.number().int(),
		passed: z.number().int(),
		failed: z.number().int(),
		advisory: z.number().int().default(0),
	}),
	pass: z.boolean(),
});

export type Metric = z.output<typeof Metric>;
export type RowVerdict = z.output<typeof RowVerdict>;
export type PixelFrame = z.output<typeof PixelFrame>;
export type PixelResult = z.output<typeof PixelResult>;
export type Guardrail = z.output<typeof Guardrail>;
export type CoverageWarning = z.output<typeof CoverageWarning>;
export type Coverage = z.output<typeof Coverage>;
export type Verdict = z.output<typeof Verdict>;
