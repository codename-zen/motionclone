import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readTrack } from "../measure/elements.ts";
import { readAnimations, readCaptureFile } from "../spec/capture-file.ts";
import { observationModel } from "../spec/observe.ts";
import { SpecFile } from "../spec/schema.ts";
import { advisoryReason } from "./advisory.ts";
import { type CloneMotion, indexClone, measureClone } from "./clone.ts";
import { checkCoverage } from "./coverage.ts";
import { evidenceOf } from "./evidence.ts";
import { guardrails } from "./guardrails.ts";
import {
	type MapEntry,
	parseMap,
	renameAnimations,
	renameTrack,
} from "./map.ts";
import {
	comparePixels,
	DEFAULT_PIXEL_THRESHOLD,
	skippedPixels,
} from "./pixels.ts";
import { measurePixelRows, needsPixels } from "./progress.ts";
import {
	checkMotionRow,
	checkStill,
	type StaggerAnchor,
	startMetric,
} from "./rows.ts";
import {
	type Coverage,
	type RowVerdict,
	VERDICT_VERSION,
	Verdict,
} from "./schema.ts";
import { isVideoCapture, setupErrors } from "./setup.ts";

export interface VerifyOptions {
	/** "pixel" also fails on rest-frame pixel differences above the threshold. */
	fidelity?: "motion" | "pixel";
	/** Mean mismatch fraction allowed on rest frames. */
	pixelThreshold?: number;
	/** A second clone capture taken with reducedMotion "reduce", for the reduced-motion guardrail. */
	reducedClone?: string;
	/**
	 * Rename the clone's track keys before comparing: "card=.card" maps every index, "card[2]=.x[0]" one element.
	 * Needed when the reference is a video, whose elements are region names.
	 */
	map?: string[];
	/** Where verdict.json goes; defaults to the clone directory, false to skip writing. */
	outDir?: string | false;
}

const json = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;

async function loadSpec(spec: string | SpecFile): Promise<SpecFile> {
	if (typeof spec !== "string") return SpecFile.parse(spec);
	return SpecFile.parse(JSON.parse(await readFile(spec, "utf8")));
}

/** Verify a clone capture against a spec drafted from the reference capture. */
export async function verify(
	specFile: string | SpecFile,
	refDir: string,
	cloneDir: string,
	opts: VerifyOptions = {},
): Promise<Verdict> {
	const fidelity = opts.fidelity ?? "motion";
	const ref = resolve(refDir);
	const clone = resolve(cloneDir);
	const spec = await loadSpec(specFile);
	const [refCap, cloneCap, refTrack, cloneTrack, cloneAnimations] =
		await Promise.all([
			readCaptureFile(ref),
			readCaptureFile(clone),
			readTrack(ref),
			readTrack(clone),
			// Without the file the clone is measured by fitting only, as for a JavaScript-driven page.
			readAnimations(clone).catch(() => []),
		]);
	const map: MapEntry[] = parseMap(opts.map ?? []);
	const video = isVideoCapture(refCap);
	const errors = setupErrors(spec.meta, refCap, cloneCap, map);
	if (video && fidelity === "pixel")
		errors.push(
			"pixel fidelity compares two page captures; use motion fidelity against a video reference",
		);
	const rows: RowVerdict[] = [];
	let pixel: Verdict["pixel"] = null;
	let coverage: Coverage | null = null;
	if (errors.length === 0) {
		const renamed = renameTrack(cloneTrack, map);
		const idx = indexClone(renamed, renameAnimations(cloneAnimations, map));
		// Video distances are CSS px; the region box and the element box differ in size, so a relative distance would not compare.
		const specRows = video
			? spec.rows.map((r) => ({ ...r, relativeDistance: null }))
			: spec.rows;
		const measured = new Map<string, CloneMotion>(
			specRows.map((r) => [r.id, measureClone(idx, r)]),
		);
		const fromPixels = specRows.filter((r) =>
			needsPixels(r, measured.get(r.id), video),
		);
		if (fromPixels.length > 0)
			for (const [id, c] of await measurePixelRows(
				clone,
				renamed,
				cloneCap.clip,
				fromPixels,
			))
				if (measured.get(id)?.status !== "missing") measured.set(id, c);
		const anchors = new Map<string, StaggerAnchor>();
		for (const r of specRows) {
			const c = measured.get(r.id);
			if (c?.status === "moving")
				anchors.set(r.id, {
					startMs: c.startMs,
					startPass: startMetric(r, c, idx.frameMs).pass,
				});
		}
		const model = observationModel(refCap);
		for (const r of specRows) {
			const anchor = r.stagger ? (anchors.get(r.stagger.after) ?? null) : null;
			const evidence = r.fromObserved ? null : evidenceOf(refTrack, r, model);
			rows.push({
				...checkMotionRow(
					r,
					measured.get(r.id) as CloneMotion,
					idx.frameMs,
					anchor,
					evidence,
				),
				advisory: advisoryReason(r),
			});
		}
		for (const s of spec.still) rows.push(checkStill(s, idx));
		const threshold = opts.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
		pixel = video
			? skippedPixels(threshold, "the reference is a video")
			: await comparePixels(ref, clone, refTrack, cloneTrack, {
					enforced: fidelity === "pixel",
					threshold,
				});
		coverage = await checkCoverage(spec, ref, refTrack, refCap.clip, video);
	}
	const checked = rows.filter((r) => r.advisory === null);
	const passed = checked.filter((r) => r.pass).length;
	const verdict = Verdict.parse({
		version: VERDICT_VERSION,
		referenceDir: ref,
		cloneDir: clone,
		fidelity,
		setupErrors: errors,
		rows,
		pixel,
		warnings: errors.length
			? []
			: await guardrails(clone, { reducedClone: opts.reducedClone }),
		coverage,
		summary: {
			rows: rows.length,
			passed,
			failed: checked.length - passed,
			advisory: rows.length - checked.length,
		},
		pass:
			errors.length === 0 &&
			passed === checked.length &&
			(pixel?.pass ?? false),
	});
	if (opts.outDir !== false)
		await writeFile(join(opts.outDir ?? clone, "verdict.json"), json(verdict));
	return verdict;
}
