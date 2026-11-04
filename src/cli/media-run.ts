import { z } from "zod";
import { designSheet } from "../media/design-sheet.ts";
import { sideBySide } from "../media/side-by-side.ts";

export const SideBySideArgs = z.object({
	refDir: z.string().describe("Reference capture directory"),
	cloneDirs: z
		.array(z.string())
		.min(1)
		.describe("Clone capture directories, left to right after the reference"),
	out: z.string().describe("Output file ending in .gif or .mp4"),
	labels: z
		.array(z.string())
		.optional()
		.describe("One label per input, reference first"),
	from: z.number().optional().describe("Start, ms from each capture's t=0"),
	to: z.number().optional().describe("End, ms from each capture's t=0"),
	fps: z.number().positive().optional(),
	width: z.number().int().positive().optional().describe("Max picture width"),
	crop: z
		.array(z.string())
		.optional()
		.describe('"x,y,w,h": one for all inputs or one per input ("-" for none)'),
	offset: z
		.array(z.number())
		.optional()
		.describe("Per input, ms into that capture that lines up with the others"),
	hold: z
		.number()
		.nonnegative()
		.optional()
		.describe("Show the last frame this many ms before the loop restarts"),
});
export type SideBySideArgs = z.output<typeof SideBySideArgs>;

export const SheetArgs = z.object({
	refDir: z.string().describe("Reference capture directory"),
	cloneDir: z.string().describe("Clone capture directory"),
	out: z.string().describe("Output directory"),
});
export type SheetArgs = z.output<typeof SheetArgs>;

export async function sideBySideLines(a: SideBySideArgs): Promise<string[]> {
	const r = await sideBySide({
		dirs: [a.refDir, ...a.cloneDirs],
		out: a.out,
		labels: a.labels,
		fromMs: a.from,
		toMs: a.to,
		fps: a.fps,
		width: a.width,
		crop: a.crop,
		offsets: a.offset,
		holdMs: a.hold,
	});
	return [
		`wrote ${r.out}`,
		`${r.frames} frames at ${r.fps} fps, ${r.width}x${r.height}, ${(r.bytes / 1048576).toFixed(2)} MB`,
		...r.warnings.map((w) => `warning: ${w}`),
	];
}

export async function sheetLines(a: SheetArgs): Promise<string[]> {
	const r = await designSheet(a.refDir, a.cloneDir, a.out);
	return [...r.moments.map((m) => m.label), `sheet: ${r.png}`];
}
