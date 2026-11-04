import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnimationRecord } from "../capture/types.ts";
import type { TimeBounds } from "../fit/plausible.ts";
import {
	type MovingProperty,
	readTrack,
	type Track,
} from "../measure/elements.ts";
import { VERSION } from "../version.ts";
import {
	type CaptureFile,
	readAnimations,
	readCaptureFile,
} from "./capture-file.ts";
import { clippedDistance, clippedRanges } from "./clipped.ts";
import { supportOf } from "./confidence.ts";
import { crossCheck } from "./cross-check.ts";
import { matchDeclared, type Timing } from "./declared.ts";
import { curveDeviation } from "./deviation.ts";
import { candidateEasing, easingLabel } from "./easing.ts";
import { draftLookOf } from "./look.ts";
import {
	elementKey,
	fitMotion,
	motionId,
	motionProperties,
	motionRange,
	trackedElements,
} from "./motion.ts";
import { type Observed, observationModel, observe } from "./observe.ts";
import { fitPartialRows, type PartialFit } from "./partial.ts";
import { keepPlausible, trackBounds } from "./plausible-rows.ts";
import { draftProgressRows } from "./progress.ts";
import {
	DEFAULT_TOLERANCES,
	type DroppedRow,
	SPEC_VERSION,
	SpecFile,
	type SpecRow,
} from "./schema.ts";

const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Number(v.toFixed(4));

function draftRow(
	m: MovingProperty,
	observed: Observed,
	animations: AnimationRecord[],
	cap: CaptureFile,
	noise: number,
	bounds: TimeBounds,
): SpecRow {
	const fit = fitMotion(m, bounds);
	const notes: string[] = [];
	const declared = matchDeclared(m, fit, animations, cap.frameMs, notes);
	const easing = declared?.easing ?? candidateEasing(fit.best);
	const timing: Timing = declared ?? {
		startMs: fit.best.delayMs,
		durationMs:
			easing.type === "spring" ? easing.settleMs : fit.best.durationMs,
		easing,
		rmse: fit.best.rmse,
	};
	if (declared)
		notes.push(
			`declared ${declared.animation.type} ${declared.animation.name || "(unnamed)"}: ${easingLabel(easing)}, track deviation ${declared.deviation.max.toFixed(4)}`,
		);
	else if (cap.stack.some((s) => s === "gsap" || s === "motion"))
		notes.push(
			"measured from the track: JavaScript timelines count from script time, 16 ms before t=0",
		);
	else notes.push("measured from the track");
	// Same free-timing deviation verify computes, so an identical clone always passes.
	const residual = curveDeviation(fit.samples, fit.hint, easing).max;
	const { confidence, support } = supportOf({
		obs: observed.obs,
		startMs: timing.startMs,
		durationMs: timing.durationMs,
		rmse: timing.rmse,
		observed: 1,
		noise,
	});
	return {
		id: motionId(m),
		selector: m.selector,
		index: m.index,
		property: m.property,
		from: r4(m.window.from),
		to: r4(m.window.to),
		fromObserved: true,
		startMs: r1(timing.startMs),
		durationMs: r1(timing.durationMs),
		easing,
		overshoot: r4(m.window.overshoot),
		relativeDistance: m.window.relative === null ? null : r4(m.window.relative),
		distanceObserved: "full",
		source: declared ? "declared" : "measured",
		confidence: declared ? "high" : confidence,
		support,
		rmse: Number(timing.rmse.toExponential(3)),
		easingResidual: Math.ceil(residual * 1e4) / 1e4,
		stagger: null,
		tolerances: { ...DEFAULT_TOLERANCES },
		notes,
	};
}

function partialRow(
	m: MovingProperty,
	observed: Observed,
	fit: PartialFit,
	noise: number,
): SpecRow {
	const { confidence, support } = supportOf({
		obs: observed.obs,
		startMs: fit.startMs,
		durationMs: fit.durationMs,
		rmse: fit.rmse,
		observed: fit.observed,
		noise,
		weak: fit.weak,
	});
	return {
		id: motionId(m),
		selector: m.selector,
		index: m.index,
		property: m.property,
		from: r4(fit.from),
		to: r4(m.window.to),
		fromObserved: false,
		startMs: r1(fit.startMs),
		durationMs: r1(fit.durationMs),
		easing: fit.easing,
		overshoot: r4(m.window.overshoot),
		relativeDistance: null,
		distanceObserved: "full",
		source: "measured",
		confidence,
		support,
		rmse: Number(fit.rmse.toExponential(3)),
		easingResidual: Math.ceil(fit.residual * 1e4) / 1e4,
		stagger: null,
		tolerances: { ...DEFAULT_TOLERANCES },
		notes: fit.notes,
	};
}

/** Rows for every motion; those whose start value the reference never shows are fitted from what it does show. */
function draftRows(
	motions: MovingProperty[],
	track: Track,
	animations: AnimationRecord[],
	cap: CaptureFile,
	bounds: TimeBounds,
): SpecRow[] {
	const model = observationModel(cap);
	const items = motions.map((m) => ({
		m,
		observed: observe(
			track,
			m.selector,
			m.index,
			m.property,
			model,
			motionRange(m),
		),
	}));
	const partial = fitPartialRows(
		items.filter((i) => !i.observed.fromObserved),
		cap.frameMs,
		model,
		bounds,
	);
	const noise = model?.noise ?? 0;
	const clipped = clippedRanges(cap);
	return items.map(({ m, observed }) => {
		const fit = partial.get(m);
		const row = fit
			? partialRow(m, observed, fit, noise)
			: draftRow(m, observed, animations, cap, noise, bounds);
		return clippedDistance(row, track, clipped);
	});
}

// The id after the element key names the row within its element: ".opacity", ".progress#2".
const rowKey = (r: SpecRow, index: number) =>
	`${r.selector}|${r.id.slice(elementKey(r.selector, r.index).length)}|${index}`;

function linkStagger(rows: SpecRow[]): void {
	const byKey = new Map(rows.map((r) => [rowKey(r, r.index), r]));
	for (const r of rows) {
		const prev = byKey.get(rowKey(r, r.index - 1));
		if (prev)
			r.stagger = { after: prev.id, gapMs: r1(r.startMs - prev.startMs) };
	}
}

const json = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;

/** Draft spec.json from a reference capture directory and write it there. */
export async function draftSpec(
	captureDir: string,
	{ write = true }: { write?: boolean } = {},
): Promise<SpecFile> {
	const dir = resolve(captureDir);
	const [cap, track, animations] = await Promise.all([
		readCaptureFile(dir),
		readTrack(dir),
		readAnimations(dir),
	]);
	const motions = motionProperties(track);
	const bounds = trackBounds(track, cap.frameMs);
	const dropped: DroppedRow[] = [];
	const rows = keepPlausible(
		draftRows(motions, track, animations, cap, bounds),
		bounds,
		dropped,
	);
	const model = observationModel(cap);
	const progress = await draftProgressRows({
		dir,
		track,
		clip: cap.clip,
		rows,
		video: model !== null,
		noise: model?.noise ?? 0,
	});
	const plausible = new Set(
		keepPlausible(
			progress.map((p) => p.row),
			bounds,
			dropped,
		),
	);
	const kept = progress.filter((p) => plausible.has(p.row));
	crossCheck(rows, kept, cap.frameMs);
	rows.push(...kept.map((p) => p.row));
	linkStagger(rows);
	const moving = new Set(motions.map((m) => elementKey(m.selector, m.index)));
	const o = cap.options;
	const spec = SpecFile.parse({
		version: SPEC_VERSION,
		meta: {
			tool: `motionclone ${VERSION}`,
			referenceDir: dir,
			url: o.url,
			viewport: o.viewport,
			trigger: o.trigger,
			fps: o.fps,
			frameMs: cap.frameMs,
			durationMs: o.durationMs,
			seed: o.seed,
			track: o.track,
			reducedMotion: o.reducedMotion,
			colorScheme: o.colorScheme,
			stack: cap.stack,
		},
		rows,
		still: trackedElements(track)
			.filter((e) => !moving.has(elementKey(e.selector, e.index)))
			.map((e) => ({
				id: elementKey(e.selector, e.index),
				selector: e.selector,
				index: e.index,
				notes: [
					"does not move in the reference: the rebuild must keep it still",
				],
			})),
		dropped,
		look: await draftLookOf(dir, cap.clip),
	});
	if (write) await writeFile(join(dir, "spec.json"), json(spec));
	return spec;
}
