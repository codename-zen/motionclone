import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtractResult } from "./extract.ts";

/** Trigger-relative ms of frame k, on the same whole-ms grid as DOM captures. */
export const frameTimeMs = (k: number, fps: number) =>
	Math.round((k * 1000) / fps);

const json = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;

/** Frames where a region cut a tracked element's travel: positions there are not observed (ADR 0002). */
export interface ClippedTravel {
	region: string;
	selector: string;
	index: number;
	fromFrame: number;
	toFrame: number;
	fromMs: number;
	toMs: number;
}

/** CSS pixels per output frame pixel. */
export const cssPerFramePx = (r: ExtractResult) => 1 / (r.scale * r.cssScale);

/** capture.json readable by spec drafting and verify, plus a `video` section with the extraction settings. */
export async function writeVideoCaptureFile(
	r: ExtractResult,
	{
		track,
		warnings,
		clipped,
	}: { track: string[]; warnings: string[]; clipped: ClippedTravel[] },
): Promise<void> {
	const viewport = {
		width: Math.max(1, Math.round(r.crop.w / r.cssScale)),
		height: Math.max(1, Math.round(r.crop.h / r.cssScale)),
	};
	const durationMs = Math.round((r.end - r.start) * 1000 * 1000) / 1000;
	await writeFile(
		join(r.outDir, "capture.json"),
		json({
			source: "video",
			options: {
				url: pathToFileURL(r.probe.path).href,
				outDir: r.outDir,
				viewport,
				deviceScaleFactor: r.scale * r.cssScale,
				trigger: { type: "none" },
				durationMs: Math.max(durationMs, r.frameMs),
				fps: r.fps,
				track,
				seed: 1,
			},
			triggerAtMs: 0,
			frames: r.frames,
			frameMs: r.frameMs,
			clip: { x: 0, y: 0, ...viewport },
			stack: ["video"],
			video: {
				probe: r.probe,
				start: r.start,
				end: r.end,
				fps: r.fps,
				crop: r.crop,
				scale: r.scale,
				cssScale: r.cssScale,
				frameSize: { width: r.width, height: r.height },
				sourceFrames: r.sourceFrames,
				clippedTravel: clipped,
			},
			versions: { node: process.version },
			warnings,
		}),
	);
}
