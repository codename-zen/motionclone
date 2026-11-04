import { readLook, regionsAt } from "../look/file.ts";
import { pixelLook } from "../look/pixels.ts";
import type { Track } from "../measure/elements.ts";
import type { CaptureFile } from "../spec/capture-file.ts";
import { DEFAULT_STRUCTURE } from "../spec/look-schema.ts";
import type { SpecFile } from "../spec/schema.ts";
import { type CloneLook, checkLookRow } from "./look-rows.ts";
import type { MapEntry } from "./map.ts";
import { readPng } from "./pixels.ts";
import type { LookResult } from "./schema.ts";
import { structureScore } from "./structure.ts";

export interface LookOptions {
	/** Failures fail the verdict: true for look and pixel fidelity. */
	enforced: boolean;
	/** Blur of the structure score, CSS px; defaults to the spec's (8). */
	blurPx?: number;
	/** Lowest structure SSIM per rest frame; defaults to the spec's (0.9). */
	structureThreshold?: number;
	/** Lowest text score per rest frame; defaults to the spec's (0.9). */
	textThreshold?: number;
}

interface LookInputs {
	spec: SpecFile;
	refDir: string;
	cloneDir: string;
	refCap: CaptureFile;
	cloneCap: CaptureFile;
	/** The clone track with --map applied. */
	cloneTrack: Track;
	map: MapEntry[];
}

function cloneTarget(map: MapEntry[], selector: string, index: number) {
	const m = map.find(
		(e) =>
			e.ref.selector === selector &&
			(e.ref.index === null || e.ref.index === index),
	);
	return m
		? { selector: m.clone.selector, index: m.clone.index ?? index }
		: { selector, index };
}

/** Look rows and the structure score of a clone against the spec's look section. */
export async function verifyLook(
	x: LookInputs,
	opts: LookOptions,
): Promise<LookResult> {
	const look = x.spec.look;
	if (!look)
		return {
			source: null,
			enforced: opts.enforced,
			rows: [],
			structure: null,
			summary: { rows: 0, passed: 0, failed: 0 },
			pass: !opts.enforced,
			skipped:
				"the spec has no look section: capture the reference with this version and draft the spec again",
		};
	const last = look.frames.at(-1);
	const frame = Math.min(last?.frame ?? 0, x.cloneCap.frames - 1);
	const clip = x.cloneCap.clip;
	const needsPixels = look.rows.some((r) => r.method === "pixels");
	const clone: CloneLook = {
		styles: (await readLook(x.cloneDir))?.states.at(-1)?.page ?? null,
		pixels: needsPixels
			? pixelLook(
					await readPng(x.cloneDir, frame),
					clip,
					regionsAt(x.cloneTrack.frames[frame]),
				)
			: null,
		screen: { x: clip.x, y: clip.y, w: clip.width, h: clip.height },
		target: (selector, index) => cloneTarget(x.map, selector, index),
	};
	const rows = look.rows.map((r) => checkLookRow(r, clone));
	// The reference's text bands per rest frame, from its own look.json.
	const refLook = await readLook(x.refDir);
	const bands = new Map(
		(refLook?.states ?? []).map((s) => [
			s.frame,
			s.pixels.bands.filter((b) => b.hex !== null),
		]),
	);
	const structure = await structureScore(
		x.refDir,
		x.cloneDir,
		look.frames,
		x.cloneCap.frames,
		x.refCap.clip.width,
		{
			blurPx: opts.blurPx ?? look.structure.blurPx ?? DEFAULT_STRUCTURE.blurPx,
			threshold:
				opts.structureThreshold ??
				look.structure.threshold ??
				DEFAULT_STRUCTURE.threshold,
			textThreshold:
				opts.textThreshold ??
				look.structure.textThreshold ??
				DEFAULT_STRUCTURE.textThreshold,
		},
		bands,
	);
	const passed = rows.filter((r) => r.pass).length;
	const ok = passed === rows.length && structure.pass;
	return {
		source: look.source,
		enforced: opts.enforced,
		rows,
		structure,
		summary: { rows: rows.length, passed, failed: rows.length - passed },
		pass: ok || !opts.enforced,
		skipped: null,
	};
}
