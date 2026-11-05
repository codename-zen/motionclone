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

/** A text line of a type row: left edge and baseline in CSS px, cap height, and its words when a style record names them. */
export const LookLine = z.object({
	x: z.number(),
	y: z.number(),
	cap: z.number(),
	text: z.string().nullable().default(null),
});

/** A reference line of a type row and the clone line read in its place; null when the clone has none there. */
export const LookLinePair = z.object({
	reference: LookLine,
	clone: LookLine.nullable(),
});

export const LookRowVerdict = z.object({
	id: z.string(),
	label: z.string(),
	measure: z.string(),
	method: z.enum(["style", "pixels"]),
	pass: z.boolean(),
	want: z.string(),
	/** Null when the clone has nothing to measure. */
	got: z.string().nullable(),
	/** CIEDE2000 for colours, relative error for sizes, worst error over its tolerance for boxes. */
	diff: z.number().nullable(),
	tol: z.number(),
	unit: z.enum(["deltaE", "relative", "tolerance"]),
	/** A fix instruction with both numbers when failing; what matched when passing. */
	message: z.string(),
	/** False when the clone's content offers nothing to compare, such as no text line in the place of one: never fails. */
	comparable: z.boolean().default(true),
	/** Type rows: each reference line with the clone line in its place; empty for other rows and in older verdicts. */
	lines: z.array(LookLinePair).default([]),
});

export const StructureFrame = z.object({
	label: z.enum(["first", "plateau", "last"]),
	frame: z.number().int(),
	t: z.number(),
	ssim: z.number(),
	/** Text score: how alike the reference's text lines sit in both frames, null without text bands or in older verdicts. */
	text: z.number().nullable().default(null),
	pass: z.boolean(),
});

/** SSIM of blurred grayscale rest frames (layout and proportions, not words or images) and the text score (type size and line placement). */
export const StructureResult = z.object({
	blurPx: z.number(),
	threshold: z.number(),
	textThreshold: z.number().nullable().default(null),
	frames: z.array(StructureFrame),
	minSsim: z.number().nullable(),
	minText: z.number().nullable().default(null),
	pass: z.boolean(),
});

export const LookResult = z.object({
	source: z.enum(["page", "video"]).nullable(),
	/** True for look and pixel fidelity: failures fail the verdict. */
	enforced: z.boolean(),
	rows: z.array(LookRowVerdict),
	structure: StructureResult.nullable(),
	summary: z.object({
		rows: z.number().int(),
		passed: z.number().int(),
		failed: z.number().int(),
		/** Rows the clone's content could not be compared with; not counted in `rows`. */
		notComparable: z.number().int().default(0),
	}),
	pass: z.boolean(),
	skipped: z.string().nullable(),
});

export const Guardrail = z.object({
	rule: z.enum(["layout-property", "ease-in-entrance", "reduced-motion"]),
	target: z.string(),
	message: z.string(),
});

/** The clone against its capture with prefers-reduced-motion: reduce (`--reduced-clone`). */
export const ReducedMotion = z.object({
	dir: z.string(),
	/** Null when the check could not run; `message` says why. */
	pass: z.boolean().nullable(),
	/** Moving properties of the clone that keep at least half their travel with reduced motion. */
	unchanged: z.array(z.string()),
	/** Every property that still moves in the reduced capture, with its values and start. */
	moved: z.array(z.string()),
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
	fidelity: z.enum(["motion", "look", "pixel"]),
	setupErrors: z.array(z.string()),
	rows: z.array(RowVerdict),
	/** Clone motions no row pairs with, where the reference does not show the element; they never fail. */
	unpaired: z.array(z.string()).default([]),
	pixel: PixelResult.nullable(),
	/** Look rows and the structure score; null for motion fidelity and in older verdicts. */
	look: LookResult.nullable().default(null),
	warnings: z.array(Guardrail),
	/** The reduced-motion check; null without `--reduced-clone` and in older verdicts. It never fails the verdict. */
	reducedMotion: ReducedMotion.nullable().default(null),
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
	/** `no-checks` when no motion or look row was checked: nothing was compared, so it is not a pass. Absent in older verdicts. */
	status: z.enum(["pass", "fail", "no-checks", "setup-error"]).optional(),
});

export type Metric = z.output<typeof Metric>;
export type RowVerdict = z.output<typeof RowVerdict>;
export type PixelFrame = z.output<typeof PixelFrame>;
export type PixelResult = z.output<typeof PixelResult>;
export type Guardrail = z.output<typeof Guardrail>;
export type ReducedMotion = z.output<typeof ReducedMotion>;
export type LookRowVerdict = z.output<typeof LookRowVerdict>;
export type LookLine = z.output<typeof LookLine>;
export type StructureFrame = z.output<typeof StructureFrame>;
export type StructureResult = z.output<typeof StructureResult>;
export type LookResult = z.output<typeof LookResult>;
export type CoverageWarning = z.output<typeof CoverageWarning>;
export type Coverage = z.output<typeof Coverage>;
export type Verdict = z.output<typeof Verdict>;
export type VerdictStatus = NonNullable<Verdict["status"]>;

/** The verdict's status; older verdicts without one get it from `pass` and their setup errors. */
export const statusOf = (v: {
	pass: boolean;
	setupErrors?: string[];
	status?: VerdictStatus;
}): VerdictStatus =>
	v.status ??
	((v.setupErrors?.length ?? 0) > 0 ? "setup-error" : v.pass ? "pass" : "fail");

interface Counted {
	summary: { rows: number; passed: number; advisory?: number };
	look?: { summary: { rows: number; passed: number } } | null;
}

/** Checked rows: motion rows without the advisory ones, plus look rows; the verdict fails on either kind. */
export function checkedCounts(v: Counted) {
	const motion = {
		passed: v.summary.passed,
		checked: v.summary.rows - (v.summary.advisory ?? 0),
	};
	const look = v.look
		? { passed: v.look.summary.passed, checked: v.look.summary.rows }
		: null;
	return {
		motion,
		look,
		passed: motion.passed + (look?.passed ?? 0),
		checked: motion.checked + (look?.checked ?? 0),
	};
}

/** "motion 4/4, look 12/13" when the verdict has look rows, else an empty string. */
export function countsByKind(v: Counted): string {
	const c = checkedCounts(v);
	return c.look
		? `motion ${c.motion.passed}/${c.motion.checked}, look ${c.look.passed}/${c.look.checked}`
		: "";
}
