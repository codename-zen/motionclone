import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { TrackedElement, TrackFrame } from "../capture/types.ts";
import {
	cssPerFramePx,
	frameTimeMs,
	writeVideoCaptureFile,
} from "./capture-file.ts";
import { type ExtractResult, extractFrames } from "./extract.ts";
import { readLuma } from "./luma.ts";
import { ExtractOptions, parseRegionName, Region } from "./options.ts";
import { findBlobs } from "./regions.ts";
import { type RegionSample, type RegionTrack, sampleBox } from "./samples.ts";
import { MIN_BLUR, type TrackRegionInput, trackRegions } from "./track.ts";

export { extractFrames } from "./extract.ts";
export { parseTime } from "./options.ts";
export { probeVideo } from "./probe.ts";

export const VideoOptions = ExtractOptions.extend({
	/** Elements to track, in source video pixels after the crop; omit to find moving blobs automatically. */
	regions: z
		.array(Region)
		.optional()
		.superRefine((rs, ctx) => {
			const seen = new Set<string>();
			for (const r of rs ?? []) {
				try {
					const { selector, index } = parseRegionName(r.name);
					const key = `${selector}[${index}]`;
					if (seen.has(key))
						ctx.addIssue({
							code: "custom",
							message: `region ${r.name} duplicates another region (${key})`,
						});
					seen.add(key);
				} catch (e) {
					ctx.addIssue({ code: "custom", message: (e as Error).message });
				}
			}
		}),
	/** Cap on automatic regions. */
	maxRegions: z.number().int().positive().default(8),
	/** Luma change (0..255, after a 3x3 blur) treated as compression noise. */
	noiseFloor: z.number().nonnegative().default(3),
});
export type VideoInput = z.input<typeof VideoOptions>;
export type VideoOptions = z.output<typeof VideoOptions>;

export interface VideoRegionSummary {
	name: string;
	ref: "first" | "last";
	/** Element box in the reference frame, CSS pixels. */
	box: { x: number; y: number; w: number; h: number };
	/** Frames where the element was visible and matched. */
	foundFrames: number;
}

export interface VideoCaptureSummary {
	outDir: string;
	frames: number;
	frameMs: number;
	fps: number;
	stack: ["video"];
	regions: VideoRegionSummary[];
	warnings: string[];
}

const json = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;
const r1 = (v: number) => Math.round(v * 10) / 10;
// The contrast proxy jitters by about 0.01 on compressed video; near full contrast it counts as opaque.
const OPAQUE_FROM = 0.98;
const opacity = (v: number) =>
	v >= OPAQUE_FROM ? 1 : Math.round(v * 100) / 100;

function toFramePx(regions: Region[], ex: ExtractResult): TrackRegionInput[] {
	return regions.map((r) => {
		const x = Math.round(r.x * ex.scale);
		const y = Math.round(r.y * ex.scale);
		const w = Math.min(ex.width - x, Math.round(r.w * ex.scale));
		const h = Math.min(ex.height - y, Math.round(r.h * ex.scale));
		if (w < 1 || h < 1 || r.x + r.w > ex.crop.w || r.y + r.h > ex.crop.h)
			throw new Error(
				`region ${r.name} lies outside the ${ex.crop.w}x${ex.crop.h} cropped video`,
			);
		return { name: r.name, ref: r.ref, x, y, w, h };
	});
}

function element(t: RegionTrack, k: number, css: number): TrackedElement {
	const s = t.samples[k] as RegionSample;
	// Regions that do not scale are tracked with scale fixed at exactly 1.
	const scale = Math.round(s.scale * 10000) / 10000;
	const b = sampleBox(t.box, { ...s, scale });
	const blur = s.blur < MIN_BLUR ? 0 : r1(s.blur * css);
	return {
		index: parseRegionName(t.name).index,
		x: r1(b.x * css),
		y: r1(b.y * css),
		w: r1(b.w * css),
		h: r1(b.h * css),
		opacity: opacity(s.opacity),
		transform: scale === 1 ? "none" : `matrix(${scale}, 0, 0, ${scale}, 0, 0)`,
		filter: blur === 0 ? "none" : `blur(${blur}px)`,
		clipPath: "none",
		color: "",
		backgroundColor: "",
		boxShadow: "none",
		quality: Math.round(s.quality * 100) / 100,
		observed: {
			position: s.found,
			scale: s.status === "found",
			blur: s.status === "found" && s.method !== "colour",
			opacity: s.status !== "other" && s.method !== "colour",
		},
	};
}

/** Turn a screen recording or gif into a capture directory that spec drafting and verify can read. */
export async function captureVideo(
	input: VideoInput,
): Promise<VideoCaptureSummary> {
	const opts = VideoOptions.parse(input);
	const ex = await extractFrames(opts);
	const warnings = [...ex.warnings];
	const dir = ex.outDir;
	let regions: TrackRegionInput[];
	let ends: {
		first: Awaited<ReturnType<typeof readLuma>>;
		last: Awaited<ReturnType<typeof readLuma>>;
	};
	if (opts.regions) {
		regions = toFramePx(opts.regions, ex);
		ends = {
			first: await readLuma(dir, 0),
			last: await readLuma(dir, ex.frames - 1),
		};
	} else {
		const found = await findBlobs(
			dir,
			ex.frames,
			opts.noiseFloor,
			opts.maxRegions,
			warnings,
		);
		regions = found.rects.map((r) => ({ ...r, ref: "auto" }));
		ends = found;
		if (regions.length === 0)
			warnings.push("no moving blobs found: nothing is tracked");
	}
	const tracks = await trackRegions(
		dir,
		ex.frames,
		regions,
		ends,
		opts.noiseFloor,
		warnings,
	);
	const css = cssPerFramePx(ex);
	const bySelector = new Map<string, RegionTrack[]>();
	for (const t of tracks) {
		const { selector } = parseRegionName(t.name);
		bySelector.set(selector, [...(bySelector.get(selector) ?? []), t]);
	}
	for (const list of bySelector.values())
		list.sort(
			(a, b) => parseRegionName(a.name).index - parseRegionName(b.name).index,
		);
	const names = [...bySelector.keys()];
	const frames: TrackFrame[] = Array.from({ length: ex.frames }, (_, k) => ({
		frame: k,
		t: frameTimeMs(k, ex.fps),
		scrollY: 0,
		elements: Object.fromEntries(
			names.map((n) => [
				n,
				(bySelector.get(n) as RegionTrack[]).map((t) => element(t, k, css)),
			]),
		),
	}));
	await writeFile(
		join(dir, "track.json"),
		json({ selectors: names, frameMs: ex.frameMs, frames }),
	);
	await writeFile(
		join(dir, "animations.json"),
		json({
			animations: [],
			cdpCreatedWithoutStart: [],
			note: "video input: no declared animations, every row is measured from pixels",
		}),
	);
	await writeFile(
		join(dir, "regions.json"),
		json({ cssPerFramePx: css, regions: tracks }),
	);
	await writeVideoCaptureFile(ex, { track: names, warnings });
	return {
		outDir: dir,
		frames: ex.frames,
		frameMs: ex.frameMs,
		fps: ex.fps,
		stack: ["video"],
		regions: tracks.map((t) => ({
			name: t.name,
			ref: t.ref,
			box: {
				x: r1(t.box.x * css),
				y: r1(t.box.y * css),
				w: r1(t.box.w * css),
				h: r1(t.box.h * css),
			},
			foundFrames: t.samples.filter((s) => s.found).length,
		})),
		warnings,
	};
}
