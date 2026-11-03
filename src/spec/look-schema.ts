import { z } from "zod";
import { FracBox } from "../look/schema.ts";

export const DEFAULT_LOOK_TOLERANCES = {
	/** CIEDE2000 between the reference colour and the clone's. */
	deltaE: 6,
	/** Relative size error, 0.08 = 8 %. */
	size: 0.08,
	/** Position error as a fraction of the screen width or height. */
	position: 0.03,
} as const;

/** Backgrounds are large flat fills measured exactly, so they get a tighter colour tolerance. */
export const BACKGROUND_DELTA_E = 3;

export const DEFAULT_STRUCTURE = {
	/** Gaussian blur, CSS px, so different words and images in the same places compare alike. */
	blurPx: 8,
	/** Lowest SSIM of the blurred grayscale rest frames. */
	threshold: 0.9,
} as const;

export const LookTolerances = z.object({
	deltaE: z.number().nonnegative().default(DEFAULT_LOOK_TOLERANCES.deltaE),
	size: z.number().nonnegative().default(DEFAULT_LOOK_TOLERANCES.size),
	position: z.number().nonnegative().default(DEFAULT_LOOK_TOLERANCES.position),
});

export const LOOK_MEASURES = [
	"page-background",
	"text-colour",
	"accent",
	"font-size",
	"element-font-size",
	"element-colour",
	"element-background",
	"element-radius",
	"element-box",
	"region-background",
	"block",
] as const;

export const LookRow = z.object({
	id: z.string(),
	/** What the row is about in words: "page background", "title font size". */
	label: z.string(),
	measure: z.enum(LOOK_MEASURES),
	/** "style" reads computed styles of a page capture; "pixels" reads rest-frame pixels, page or video. */
	method: z.enum(["style", "pixels"]),
	target: z
		.object({ selector: z.string(), index: z.number().int().nonnegative() })
		.nullable()
		.default(null),
	/** For font sizes: "title" (largest) or "body" (most characters). */
	role: z.enum(["title", "body"]).nullable().default(null),
	colour: z.string().nullable().default(null),
	px: z.number().nullable().default(null),
	/** Fractions of the screen. */
	box: FracBox.nullable().default(null),
	/** Share of the screen the colour covers in the reference. */
	share: z.number().nullable().default(null),
	tolerances: LookTolerances.prefault({}),
	notes: z.array(z.string()).default([]),
});

export const LookFrame = z.object({
	label: z.enum(["first", "plateau", "last"]),
	frame: z.number().int().nonnegative(),
	t: z.number(),
});

export const LookSpec = z.object({
	source: z.enum(["page", "video"]),
	/** Reference rest frames: rows describe the last one, the structure score compares all. */
	frames: z.array(LookFrame),
	structure: z
		.object({
			blurPx: z.number().nonnegative().default(DEFAULT_STRUCTURE.blurPx),
			threshold: z.number().min(0).max(1).default(DEFAULT_STRUCTURE.threshold),
		})
		.prefault({}),
	rows: z.array(LookRow),
});

export type LookTolerances = z.output<typeof LookTolerances>;
export type LookRow = z.output<typeof LookRow>;
export type LookMeasure = LookRow["measure"];
export type LookSpec = z.output<typeof LookSpec>;
export type LookFrame = z.output<typeof LookFrame>;
