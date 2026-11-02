import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureOptions, ClipRect } from "../capture/options.ts";
import type { AnimationRecord, StackKind } from "../capture/types.ts";

/** capture.json as written by captureMotion. */
export interface CaptureFile {
	options: CaptureOptions;
	triggerAtMs: number;
	frames: number;
	frameMs: number;
	clip: ClipRect;
	stack: StackKind[];
	warnings: string[];
}

const readJson = async <T>(dir: string, file: string): Promise<T> =>
	JSON.parse(await readFile(join(dir, file), "utf8")) as T;

export const readCaptureFile = (dir: string): Promise<CaptureFile> =>
	readJson<CaptureFile>(dir, "capture.json");

/** nth-child path of each tracked element by selector and index; empty for captures that predate it. */
export async function readTrackedPaths(
	dir: string,
): Promise<Record<string, string[]>> {
	const file = await readJson<{ trackedPaths?: Record<string, string[]> }>(
		dir,
		"animations.json",
	);
	return file.trackedPaths ?? {};
}

export async function readAnimations(dir: string): Promise<AnimationRecord[]> {
	const file = await readJson<{ animations: AnimationRecord[] }>(
		dir,
		"animations.json",
	);
	return file.animations;
}
