import type { TrackedElement } from "../capture/types.ts";
import type { Observation } from "../fit/types.ts";
import type { Track } from "../measure/elements.ts";
import { type Property, readProperty } from "../measure/series.ts";
import type { CaptureFile } from "./capture-file.ts";

/** How trustworthy a capture's readings are; null for page captures, whose readings are exact. */
export type ObservationModel = {
	/** Smallest blur the tracker reports, CSS px; less reads as none. */
	blurFloor: number;
	/** Typical error of a plain reading, in units of the visible change. */
	noise: number;
} | null;

export interface Observed {
	obs: Observation[];
	/** The first frame's reading is a plain value, so the start value was seen. */
	fromObserved: boolean;
	/** The frames before the motion are covered by readings or bounds, so they can pin its start. */
	boundedStart: boolean;
}

// Measured on h264 crf 18 (ADR 0003): opacity 0.125 reads 0, 0.235 reads 0.14 to 0.15, and readings from 0.98 snap to 1.
const ZERO_UP_TO = 0.15;
const FAINT_BELOW = 0.3;
const FAINT_UNDER_READ = 0.12;
const OPAQUE_FROM = 0.95;
// The opacity proxy jitters by about 0.03 and errs by up to 0.05 mid-move on h264 crf 18 (ADR 0002).
const VIDEO_NOISE = 0.03;
// Matches the tracker: under this opacity proxy, scale and blur are filled in, not measured.
const SHAPE_FROM = 0.2;
const SHAPES = new Set<Property>(["scale", "scaleX", "scaleY", "blur"]);

/** The observation model of a capture: video readings carry the tracker's known bounds. */
export function observationModel(cap: CaptureFile): ObservationModel {
	const video = (
		cap as { source?: string; video?: { scale: number; cssScale: number } }
	).video;
	if ((cap as { source?: string }).source !== "video" || !video) return null;
	return { blurFloor: 1 / (video.scale * video.cssScale), noise: VIDEO_NOISE };
}

/** Values a property can take; video scale stays within what the tracker searches (ADR 0002). */
export function valueRange(
	property: Property,
	model: ObservationModel,
): [number, number] {
	if (property === "opacity") return [0, 1];
	if (property === "blur") return [0, Number.POSITIVE_INFINITY];
	if (property.startsWith("scale"))
		return model ? [0.3, 3] : [0, Number.POSITIVE_INFINITY];
	return [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
}

const point = (t: number, v: number): Observation => ({ t, lo: v, hi: v });

/** Optional per-frame fields a video tracker may add (ADR 0002). */
interface VideoSample {
	quality?: number;
	observed?: Partial<
		Record<"position" | "scale" | "blur" | "opacity", boolean>
	>;
}

const groupOf = (p: Property) =>
	p === "opacity" || p === "blur" ? p : p.startsWith("scale") ? "scale" : null;

/**
 * The tracker says it did not see this property on this frame, so the value is filled in.
 * Positions stay values: the tracker holds an entering element at its extrapolated start (ADR 0002, 0003).
 * An opacity of 0 stays a bound: not finding the element is what an invisible element looks like. Where light and
 * dark swapped behind it, other structure in its place is more likely the element in mid-fade: no reading.
 */
function unobserved(e: TrackedElement, p: Property): boolean {
	const group = groupOf(p);
	if (group === null || (e as VideoSample).observed?.[group] !== false)
		return false;
	return !(group === "opacity" && e.opacity === 0 && !e.flipped);
}

function videoReading(
	e: TrackedElement,
	t: number,
	property: Property,
	model: NonNullable<ObservationModel>,
): Observation | null {
	if (unobserved(e, property)) return null;
	const o = boundedReading(e, t, property, model);
	if (!o) return null;
	const q = (e as VideoSample).quality;
	const filled =
		groupOf(property) === null &&
		(e as VideoSample).observed?.position === false;
	return {
		...o,
		...(typeof q === "number" ? { q } : {}),
		...(filled ? { filled } : {}),
	};
}

function boundedReading(
	e: TrackedElement,
	t: number,
	property: Property,
	model: NonNullable<ObservationModel>,
): Observation | null {
	const v = readProperty(e, property);
	if (property === "opacity") {
		if (v === 0) return { t, lo: 0, hi: ZERO_UP_TO };
		if (v < FAINT_BELOW) return { t, lo: v, hi: v + FAINT_UNDER_READ };
		if (v >= 1) return { t, lo: OPAQUE_FROM, hi: 1 };
		return point(t, v);
	}
	if (SHAPES.has(property) && e.opacity < SHAPE_FROM) return null;
	if (property === "blur" && v === 0) return { t, lo: 0, hi: model.blurFloor };
	return point(t, v);
}

/**
 * Positions the tracker filled in before it first saw the element hold its extrapolated start (ADR 0002): the
 * true start lies there or further from the end value, so they bound the start on that side only.
 */
function boundLeadingFills(obs: Observation[]): void {
	const to = obs.at(-1)?.lo ?? 0;
	for (let k = 0; k < obs.length; k++) {
		const o = obs[k] as Observation;
		if (!o.filled) return;
		obs[k] =
			o.lo >= to
				? { ...o, hi: Number.POSITIVE_INFINITY }
				: { ...o, lo: Number.NEGATIVE_INFINITY };
	}
}

/** Readings of one property as values or bounds, with frames that hold no reading left out; `range` limits them to one motion. */
export function observe(
	track: Track,
	selector: string,
	index: number,
	property: Property,
	model: ObservationModel,
	range?: [number, number],
): Observed {
	const obs: Observation[] = [];
	const frames = range
		? track.frames.filter((f) => f.t >= range[0] && f.t <= range[1])
		: track.frames;
	const firstT = frames[0]?.t ?? 0;
	let presentAtStart = false;
	for (const f of frames) {
		const e = f.elements[selector]?.find((x) => x.index === index);
		if (!e) continue;
		if (f.t === firstT) presentAtStart = true;
		const o = model
			? videoReading(e, f.t, property, model)
			: point(f.t, readProperty(e, property));
		if (o) obs.push(o);
	}
	if (model) boundLeadingFills(obs);
	const first = obs[0];
	const second = obs[1];
	if (!model) {
		// A page element that appears mid-motion shows no start value.
		const range =
			Math.max(...obs.map((o) => o.lo)) - Math.min(...obs.map((o) => o.lo));
		const moving =
			!presentAtStart &&
			!!first &&
			!!second &&
			Math.abs(second.lo - first.lo) > 0.01 * range;
		return { obs, fromObserved: !moving, boundedStart: !moving };
	}
	const atStart = first?.t === firstT;
	return {
		obs,
		fromObserved: atStart && !!first && first.lo === first.hi,
		boundedStart: atStart,
	};
}
