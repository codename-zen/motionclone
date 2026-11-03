import type { ClipRect } from "../capture/options.ts";
import type { Track } from "../measure/elements.ts";
import { extractSeries, PROPERTIES, type Property } from "../measure/series.ts";
import { elementKey, trackedElements } from "../spec/motion.ts";
import { PROGRESS, type SpecFile } from "../spec/schema.ts";
import { type Activity, pixelActivity } from "./activity.ts";
import type { Coverage, CoverageWarning } from "./schema.ts";
import { unmeasuredChanges } from "./unmeasured.ts";

// What each source can and cannot turn into rows; "content" is anything drawn inside the box (text, images, canvas).
const SOURCES = {
	page: {
		measured: [...PROPERTIES],
		notMeasured: ["colour", "background", "shadow", "clip-path", "content"],
		hint: "content, colour or an untracked child?",
		pixelDiff: 16,
	},
	video: {
		measured: ["opacity", "x", "y", "scale", "blur"],
		notMeasured: [
			"rotation",
			"size",
			"colour",
			"background",
			"shadow",
			"clip-path",
			"content",
		],
		hint: "blur, scale, rotation, colour or content swap?",
		pixelDiff: 32,
	},
} as const;

/** Unexplained change inside an element must exceed both, per frame, to count. */
const ELEMENT_MIN_PX = 64;
const ELEMENT_MIN_FRACTION = 0.005;
/** Change outside every tracked element must exceed this, per frame, in CSS px squared. */
const UNTRACKED_MIN_PX = 64;

interface Window {
	from: number;
	to: number;
	peak: number;
	peakFrame: number;
}

/** Quiet gaps up to this long join two bursts of change into one window. */
const MERGE_GAP_MS = 100;

// Frames over the limit, merged across short quiet gaps; a window runs from the frame before the first change.
function windows(values: number[], t: number[], limit: number): Window[] {
	const out: Window[] = [];
	let cur: Window | null = null;
	for (let i = 1; i < values.length; i++) {
		const v = values[i] ?? 0;
		if (v <= limit) continue;
		const from = t[i - 1] ?? 0;
		const to = t[i] ?? 0;
		if (cur && from - cur.to <= MERGE_GAP_MS) {
			cur.to = to;
			if (v > cur.peak) Object.assign(cur, { peak: v, peakFrame: i });
		} else {
			if (cur) out.push(cur);
			cur = { from, to, peak: v, peakFrame: i };
		}
	}
	if (cur) out.push(cur);
	return out;
}

/** Per frame i, the element keys with a spec row moving between frame i-1 and frame i. */
function explainedFrames(spec: SpecFile, track: Track): Set<string>[] {
	const n = track.frames.length;
	const out = Array.from({ length: n }, () => new Set<string>());
	const t = track.frames.map((f) => f.t);
	const frameMs = track.frameMs;
	for (const r of spec.rows) {
		const key = elementKey(r.selector, r.index);
		// A progress row has no track series: it explains change in its element's box while it runs.
		const series =
			r.property === PROGRESS
				? []
				: extractSeries(
						track.frames,
						r.selector,
						r.index,
						r.property as Property,
					);
		const values = new Map(series.map(([ts, v]) => [ts, v]));
		const eps = 1e-4 * Math.max(Math.abs(r.to - r.from), 1e-3);
		const start = r.startMs - frameMs;
		const end = r.startMs + r.durationMs + frameMs;
		for (let i = 1; i < n; i++) {
			const t0 = t[i - 1] ?? 0;
			const t1 = t[i] ?? 0;
			const a = values.get(t0);
			const b = values.get(t1);
			const moving =
				a !== undefined && b !== undefined && Math.abs(b - a) > eps;
			if (moving || (t1 > start && t0 < end)) out[i]?.add(key);
		}
	}
	return out;
}

const ms = (v: number) => Math.round(v);

function activityWarnings(a: Activity, hint: string): CoverageWarning[] {
	const out: CoverageWarning[] = [];
	for (const [key, values] of a.elements) {
		const limit = Math.max(
			ELEMENT_MIN_PX,
			ELEMENT_MIN_FRACTION * (a.areas.get(key) ?? 0),
		);
		for (const w of windows(values, a.t, limit))
			out.push({
				rule: "unexplained-change",
				target: key,
				fromMs: w.from,
				toMs: w.to,
				message: `${key}: visible change from ${ms(w.from)} to ${ms(w.to)} ms that no row explains (${hint})`,
			});
	}
	for (const w of windows(a.untracked, a.t, UNTRACKED_MIN_PX)) {
		const b = a.untrackedBox[w.peakFrame];
		const where = b
			? ` around x ${ms(b.x0)}, y ${ms(b.y0)}, ${ms(b.x1 - b.x0)}x${ms(b.y1 - b.y0)} px`
			: "";
		out.push({
			rule: "untracked-motion",
			target: "untracked",
			fromMs: w.from,
			toMs: w.to,
			message: `untracked motion: visible change from ${ms(w.from)} to ${ms(w.to)} ms outside every tracked element${where}; track it to measure it`,
		});
	}
	return out;
}

/** What the verdict measured per element, and reference change it cannot account for. */
export async function checkCoverage(
	spec: SpecFile,
	refDir: string,
	refTrack: Track,
	clip: ClipRect,
	video: boolean,
): Promise<Coverage> {
	const source = video ? "video" : "page";
	const s = SOURCES[source];
	const elements = trackedElements(refTrack).map(({ selector, index }) => {
		const id = elementKey(selector, index);
		return {
			id,
			selector,
			index,
			rows: spec.rows
				.filter((r) => r.selector === selector && r.index === index)
				.map((r) => r.property),
			measured: [...s.measured],
			notMeasured: [...s.notMeasured],
		};
	});
	const explained = explainedFrames(spec, refTrack);
	const activity = await pixelActivity({
		dir: refDir,
		track: refTrack,
		clip,
		explained: (i) => explained[i] ?? new Set(),
		pixelDiff: s.pixelDiff,
	});
	return {
		source,
		elements,
		warnings: [
			...(video ? [] : unmeasuredChanges(refTrack)),
			...activityWarnings(activity, s.hint),
		],
	};
}
