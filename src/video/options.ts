import { z } from "zod";

/** Seconds from a number (seconds), "1.5", "1.5s", "1500ms", "m:ss.s" or "h:mm:ss.s". */
export function parseTime(value: number | string): number {
	if (typeof value === "number") return value;
	const s = value.trim();
	const ms = /^(\d+(?:\.\d+)?)ms$/.exec(s);
	if (ms) return Number(ms[1]) / 1000;
	const sec = /^(\d+(?:\.\d+)?)s?$/.exec(s);
	if (sec) return Number(sec[1]);
	const clock = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s);
	if (clock && Number(clock[3]) < 60)
		return (
			Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
		);
	throw new Error(
		`cannot read the time "${value}": use seconds, 1500ms or m:ss.s`,
	);
}

export const Time = z
	.union([z.number().nonnegative(), z.string()])
	.transform((v, ctx) => {
		try {
			return parseTime(v);
		} catch (e) {
			ctx.addIssue({ code: "custom", message: (e as Error).message });
			return z.NEVER;
		}
	});

const px = z.number().int().nonnegative();
const size = z.number().int().positive();

export const PixelRect = z.object({ x: px, y: px, w: size, h: size });
export type PixelRect = z.output<typeof PixelRect>;

export const Region = PixelRect.extend({
	name: z.string().min(1),
	/** Which end of the clip shows the element; auto picks the end with more contrast in the region. */
	ref: z.enum(["auto", "first", "last"]).default("auto"),
});
export type Region = z.output<typeof Region>;

export const ExtractOptions = z.object({
	input: z.string().min(1),
	outDir: z.string().min(1),
	start: Time.default(0),
	/** Defaults to the last source frame. */
	end: Time.optional(),
	/** Defaults to the source rate, capped at 60. */
	fps: z.number().positive().max(240).optional(),
	/** In source video pixels. */
	crop: PixelRect.optional(),
	/** Scale the cropped frames to this width in pixels, keeping the aspect ratio. */
	width: size.optional(),
	/** Source video pixels per CSS pixel: 2 for a recording of a 2x screen. */
	cssScale: z.number().positive().default(1),
});
export type ExtractInput = z.input<typeof ExtractOptions>;
export type ExtractOptions = z.output<typeof ExtractOptions>;

/** "card[2]" is selector "card", index 2; a plain name is index 0. */
export function parseRegionName(name: string): {
	selector: string;
	index: number;
} {
	const m = /^([^[\]]+)(?:\[(\d+)\])?$/.exec(name);
	if (!m)
		throw new Error(
			`bad region name "${name}": use a plain name or name[index], like card[0]`,
		);
	return { selector: m[1] as string, index: Number(m[2] ?? 0) };
}
