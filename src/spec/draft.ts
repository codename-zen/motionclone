import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnimationRecord } from "../capture/types.ts";
import { type MovingProperty, readTrack } from "../measure/elements.ts";
import { VERSION } from "../version.ts";
import {
	type CaptureFile,
	readAnimations,
	readCaptureFile,
} from "./capture-file.ts";
import { type CurveDeviation, curveDeviation } from "./deviation.ts";
import {
	candidateEasing,
	curveSpanMs,
	declaredEasing,
	easingLabel,
} from "./easing.ts";
import {
	elementKey,
	type FittedMotion,
	fitMotion,
	motionProperties,
	trackedElements,
} from "./motion.ts";
import {
	DEFAULT_TOLERANCES,
	type Easing,
	SPEC_VERSION,
	SpecFile,
	type SpecRow,
} from "./schema.ts";

const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Number(v.toFixed(4));

interface Timing {
	startMs: number;
	durationMs: number;
	easing: Easing;
	rmse: number;
}

interface Declared extends Timing {
	animation: AnimationRecord;
	deviation: CurveDeviation;
}

const confidenceOf = (rmse: number): SpecRow["confidence"] =>
	rmse < 0.005 ? "high" : rmse < 0.02 ? "medium" : "low";

// CSS transitions name their property, so an opacity transition cannot explain a transform and vice versa.
function canDrive(a: AnimationRecord, property: string): boolean {
	if (a.type !== "CSSTransition" || a.name === "all") return true;
	return (a.name === "opacity") === (property === "opacity");
}

/** The tracked element's CSS or WAAPI animation that explains this motion, checked against the track. */
function matchDeclared(
	m: MovingProperty,
	fit: FittedMotion,
	animations: AnimationRecord[],
	frameMs: number,
	notes: string[],
): Declared | null {
	const startTol = Math.max(DEFAULT_TOLERANCES.startMs, frameMs);
	let best: Declared | null = null;
	for (const a of animations) {
		if (
			!a.tracked.some((t) => t.selector === m.selector && t.index === m.index)
		)
			continue;
		if (a.canceled || a.timeline !== "document" || a.startMs === null) continue;
		if (!canDrive(a, m.property)) continue;
		const label = `${a.type} ${a.name || "(unnamed)"}`;
		if (
			a.iterations !== 1 ||
			a.direction !== "normal" ||
			a.playbackRate !== 1 ||
			typeof a.duration !== "number"
		) {
			notes.push(
				`${label} repeats, reverses or has no fixed duration: measured instead`,
			);
			continue;
		}
		const easing = declaredEasing(a);
		if (!easing) {
			notes.push(
				`${label} easing "${a.easing}" is not one curve: measured instead`,
			);
			continue;
		}
		const startMs = a.startMs + a.delay;
		if (Math.abs(startMs - fit.best.delayMs) > startTol) continue;
		const deviation = curveDeviation(fit.samples, fit.hint, easing, {
			delayMs: startMs,
			spanMs: curveSpanMs(easing, a.duration),
		});
		if (deviation.max > DEFAULT_TOLERANCES.easing) {
			notes.push(
				`${label} does not match the track (max deviation ${deviation.max.toFixed(3)}): measured instead`,
			);
			continue;
		}
		if (!best || deviation.max < best.deviation.max)
			best = {
				startMs,
				durationMs: a.duration,
				easing,
				rmse: deviation.rmse,
				animation: a,
				deviation,
			};
	}
	return best;
}

function draftRow(
	m: MovingProperty,
	animations: AnimationRecord[],
	cap: CaptureFile,
): SpecRow {
	const fit = fitMotion(m);
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
	return {
		id: `${elementKey(m.selector, m.index)}.${m.property}`,
		selector: m.selector,
		index: m.index,
		property: m.property,
		from: r4(m.window.from),
		to: r4(m.window.to),
		startMs: r1(timing.startMs),
		durationMs: r1(timing.durationMs),
		easing,
		overshoot: r4(m.window.overshoot),
		relativeDistance: m.window.relative === null ? null : r4(m.window.relative),
		source: declared ? "declared" : "measured",
		confidence: declared ? "high" : confidenceOf(timing.rmse),
		rmse: Number(timing.rmse.toExponential(3)),
		easingResidual: Math.ceil(residual * 1e4) / 1e4,
		stagger: null,
		tolerances: { ...DEFAULT_TOLERANCES },
		notes,
	};
}

function linkStagger(rows: SpecRow[]): void {
	const byKey = new Map(
		rows.map((r) => [`${r.selector}|${r.property}|${r.index}`, r]),
	);
	for (const r of rows) {
		const prev = byKey.get(`${r.selector}|${r.property}|${r.index - 1}`);
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
	const rows = motions.map((m) => draftRow(m, animations, cap));
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
	});
	if (write) await writeFile(join(dir, "spec.json"), json(spec));
	return spec;
}
