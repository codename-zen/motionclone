import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { TrackedElement, TrackFrame } from "../capture/types.ts";
import { writeVideoLook } from "../look/video.ts";
import { changePeaks, findBlobs } from "./blobs.ts";
import {
	type ClippedTravel,
	cssPerFramePx,
	frameTimeMs,
	writeVideoCaptureFile,
} from "./capture-file.ts";
import { type ExtractResult, extractFrames } from "./extract.ts";
import { ExtractOptions, parseRegionName, Region } from "./options.ts";
import { type RegionSample, type RegionTrack, sampleBox } from "./samples.ts";
import { scanClip } from "./scan.ts";
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
	/** The clip end the reference frame is, or `rest` for a rest plateau inside the clip. */
	ref: "first" | "last" | "rest";
	refFrame: number;
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

/** A tracked element, plus `clipped`: the region cut its travel on this frame (ADR 0002). */
function element(
	t: RegionTrack,
	k: number,
	css: number,
): TrackedElement & { clipped: boolean } {
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
			position: s.found && !s.clipped,
			scale: s.status === "found",
			blur: s.status === "found" && s.method !== "colour",
			opacity: s.status !== "other" && s.method !== "colour",
		},
		clipped: s.clipped,
	};
}

/** Frame ranges where a region cut an element's travel, for capture.json and the warnings. */
function clippedTravel(tracks: RegionTrack[], fps: number): ClippedTravel[] {
	return tracks.flatMap((t) => {
		const { selector, index } = parseRegionName(t.name);
		return t.clipped.map((c) => ({
			region: t.name,
			selector,
			index,
			fromFrame: c.from,
			toFrame: c.to,
			fromMs: frameTimeMs(c.from, fps),
			toMs: frameTimeMs(c.to, fps),
		}));
	});
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
	const changes = opts.regions ? null : changePeaks(ex.width, ex.height);
	const scan = await scanClip(dir, ex.frames, changes?.visit);
	if (opts.regions) regions = toFramePx(opts.regions, ex);
	else {
		const found = await findBlobs(
			dir,
			scan,
			changes as ReturnType<typeof changePeaks>,
			opts.noiseFloor,
			opts.maxRegions,
			warnings,
		);
		regions = found.map((r) => ({ ...r, ref: "auto" }));
		if (regions.length === 0)
			warnings.push("no moving blobs found: nothing is tracked");
	}
	const tracks = await trackRegions(
		dir,
		scan,
		regions,
		opts.noiseFloor,
		warnings,
	);
	const clipped = clippedTravel(tracks, ex.fps);
	for (const c of clipped)
		warnings.push(
			`region ${c.region}: the element reaches past the region edge while it moves on frames ${c.fromFrame}-${c.toFrame} (${c.fromMs}-${c.toMs} ms); positions there are not observed and its travel may be truncated: widen the region to cover the whole move`,
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
	await writeVideoCaptureFile(ex, { track: names, warnings, clipped });
	await writeVideoLook(dir);
	return {
		outDir: dir,
		frames: ex.frames,
		frameMs: ex.frameMs,
		fps: ex.fps,
		stack: ["video"],
		regions: tracks.map((t) => ({
			name: t.name,
			ref: t.ref,
			refFrame: t.refFrame,
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
