import { z } from "zod";

export const LOOK_VERSION = 1;
export const LOOK_FILE = "look.json";

/** CSS px in the coordinates of the track's element boxes. */
export const Box = z.object({
	x: z.number(),
	y: z.number(),
	w: z.number(),
	h: z.number(),
});

/** Computed style of one visible element; colours are "#rrggbb" or "#rrggbbaa". */
export const StyleEntry = z.object({
	/** Index of the nearest dumped ancestor, -1 for the target itself. */
	parent: z.number().int(),
	tag: z.string(),
	name: z.string(),
	box: Box,
	fontFamily: z.string(),
	fontSize: z.number(),
	fontWeight: z.number(),
	/** Px; null for "normal". */
	lineHeight: z.number().nullable(),
	letterSpacing: z.number(),
	color: z.string(),
	background: z.string(),
	/** The opaque colour seen behind the element's content: its background over its ancestors'. */
	effectiveBackground: z.string(),
	/** Top-left radius in px. */
	radius: z.number(),
	/** "1px solid #d2d2d7", or null without a visible border. */
	border: z.string().nullable(),
	boxShadow: z.string(),
	/** Including ancestors. */
	opacity: z.number(),
	/** The element's own text, whitespace collapsed, cut to 60 characters. */
	text: z.string(),
	textLength: z.number().int(),
});

export const PageStyles = z.object({
	/** The colour behind the target: the first opaque background up its ancestors, white at the root. */
	background: z.string(),
	target: z.string(),
	elements: z.array(StyleEntry),
	/** Indexes into `elements` per tracked selector and index; -1 when the element is not visible. */
	tracked: z.record(z.string(), z.array(z.number().int())),
	truncated: z.boolean(),
});

export const Swatch = z.object({ hex: z.string(), share: z.number() });

/** Fractions of the screen, 0..1. */
export const FracBox = z.object({
	x: z.number(),
	y: z.number(),
	w: z.number(),
	h: z.number(),
});

export const Block = FracBox.extend({ hex: z.string(), fill: z.number() });
export const Band = FracBox.extend({
	/** Main ink colour of the band, null when it has too few ink pixels. */
	hex: z.string().nullable(),
	/** Height in CSS px. */
	px: z.number(),
});

export const RegionLook = z.object({
	key: z.string(),
	box: Box,
	background: z.string(),
	palette: z.array(Swatch),
});

export const PixelLook = z.object({
	background: z.string(),
	text: z.string().nullable(),
	palette: z.array(Swatch),
	/** Colours of uniform surfaces (backgrounds and blocks) by area. */
	surfaces: z.array(Swatch),
	regions: z.array(RegionLook),
	blocks: z.array(Block),
	bands: z.array(Band),
});

export const LookState = z.object({
	label: z.enum(["first", "plateau", "last"]),
	frame: z.number().int(),
	t: z.number(),
	/** False when the frame still changes: the capture never settles there. */
	rest: z.boolean(),
	page: PageStyles.nullable(),
	pixels: PixelLook,
});

const Count = z.object({ px: z.number(), count: z.number().int() });

export const DesignSummary = z.object({
	palette: z.array(Swatch),
	textColours: z.array(Swatch),
	typeScale: z.array(
		Count.extend({
			weights: z.array(z.number()),
			families: z.array(z.string()),
			examples: z.array(z.string()),
		}),
	),
	radii: z.array(Count),
	spacing: z.array(Count),
});

export const LookFile = z.object({
	version: z.literal(LOOK_VERSION),
	source: z.enum(["page", "video"]),
	/** CSS px of the captured area. */
	screen: z.object({ width: z.number(), height: z.number() }),
	states: z.array(LookState),
	summary: DesignSummary,
	warnings: z.array(z.string()),
});

export type Box = z.output<typeof Box>;
export type FracBox = z.output<typeof FracBox>;
export type StyleEntry = z.output<typeof StyleEntry>;
export type PageStyles = z.output<typeof PageStyles>;
export type Swatch = z.output<typeof Swatch>;
export type Block = z.output<typeof Block>;
export type Band = z.output<typeof Band>;
export type RegionLook = z.output<typeof RegionLook>;
export type PixelLook = z.output<typeof PixelLook>;
export type LookState = z.output<typeof LookState>;
export type DesignSummary = z.output<typeof DesignSummary>;
export type LookFile = z.output<typeof LookFile>;
