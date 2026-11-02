import {
	fitJoint,
	type JointFit,
	type PartialTrack,
	visibleChange,
} from "../fit/joint.ts";
import type { Hint } from "../fit/types.ts";
import type { MovingProperty } from "../measure/elements.ts";
import { bezierEasing } from "./easing.ts";
import { type ObservationModel, type Observed, valueRange } from "./observe.ts";
import type { Easing } from "./schema.ts";

export interface PartialItem {
	m: MovingProperty;
	observed: Observed;
}

export interface PartialFit {
	startMs: number;
	durationMs: number;
	easing: Easing;
	/** Fitted start value, not seen. */
	from: number;
	rmse: number;
	/** Largest distance from a reading to the curve, in units of the visible change. */
	residual: number;
	/** Share of the change the readings show. */
	observed: number;
	/** Reasons the fit is weak on its own, such as a start value the readings put far outside what they show. */
	weak: string[];
	notes: string[];
}

// A track accepts a shared fit unless it costs more than this rms (visible-change units) over a fit of its own.
const JOIN_MARGIN = 0.03;
// A start value may lie at most this many visible changes from the end value: the visible range plus the change again.
const REACH = 2;

/** Fit settings shared by every fit of one draft. */
interface Context {
	frameMs: number;
	model: ObservationModel;
	/** Tracks whose readings pointed beyond REACH, with that start value; they are held to the visible range. */
	capped: Map<PartialItem, number>;
}

const label = (m: MovingProperty) => `${m.selector}[${m.index}].${m.property}`;
const elementOf = (m: MovingProperty) => `${m.selector}[${m.index}]`;
const round = (v: number) => Number(v.toFixed(3));

/** Tracks whose frames before the motion carry bounds (an opacity that reads 0) set the timing; the rest follow. */
const leadOf = (items: readonly PartialItem[]) => {
	const anchors = items.filter((i) => i.observed.boundedStart);
	return anchors.length > 0 ? anchors : items;
};

const hintOf = (items: readonly PartialItem[], frameMs: number): Hint => ({
	startMs: Math.min(...items.map((i) => i.m.window.startMs)),
	endMs: Math.max(...items.map((i) => i.m.window.endMs)),
	frameMs,
});

/** Bounds for a track's start value: what the property allows, within REACH visible changes of the end value. */
function rangeOf(i: PartialItem, ctx: Context): [number, number] {
	const to = i.m.window.to;
	const reach =
		(ctx.capped.has(i) ? 1 : REACH) * visibleChange(i.observed.obs, to);
	const [lo, hi] = valueRange(i.m.property, ctx.model);
	return [Math.max(lo, to - reach), Math.min(hi, to + reach)];
}

/** One fit over elements (one delay each) and their tracks; returns the items in fit order with the fit. */
function fitElements(
	elements: readonly PartialItem[][],
	ctx: Context,
): { items: PartialItem[]; fit: JointFit } {
	const items = elements.flat();
	const tracks: PartialTrack[] = elements.flatMap((group, g) => {
		const lead = leadOf(group);
		return group.map((i) => ({
			obs: i.observed.obs,
			to: i.m.window.to,
			weight: lead.includes(i) ? 1 : 0,
			group: g,
			range: rangeOf(i, ctx),
		}));
	});
	const hints = elements.map((group) => hintOf(leadOf(group), ctx.frameMs));
	return { items, fit: fitJoint(tracks, hints, ctx.model?.noise ?? 0) };
}

interface Placed {
	fit: JointFit;
	/** Track index in the fit. */
	at: number;
	/** Delay index in the fit. */
	group: number;
	notes: string[];
}

function result(
	item: PartialItem,
	{ fit, at, group, notes }: Placed,
	capped: ReadonlyMap<PartialItem, number>,
): PartialFit {
	const from = fit.froms[at] as number;
	const firstPlain = item.observed.obs.find((o) => o.lo === o.hi);
	const to = item.m.window.to;
	const change = Math.abs(from - to);
	const wanted = capped.get(item);
	return {
		startMs: fit.delays[group] as number,
		durationMs: fit.durationMs,
		easing: bezierEasing(fit.p),
		from,
		rmse: fit.rmse[at] as number,
		residual: fit.max[at]?.value ?? 0,
		observed:
			change > 0
				? Math.min(1, visibleChange(item.observed.obs, to) / change)
				: 1,
		weak:
			wanted === undefined
				? []
				: [
						`the readings put the start value at ${round(wanted)}, more than the visible change beyond what the reference shows; drafted from the visible range only`,
					],
		notes: [
			`start value not visible in the reference: ${round(from)} is extrapolated from the readings${firstPlain ? ` from ${Math.round(firstPlain.t)} ms` : ""}; verify checks the clone against the visible readings`,
			...notes,
		],
	};
}

/** One element: shared timing from its lead tracks; a follower the shared timing does not explain gets its own fit. */
function placeElement(
	group: readonly PartialItem[],
	ctx: Context,
	placed: Map<PartialItem, Placed>,
): void {
	const { items, fit } = fitElements([[...group]], ctx);
	const lead = leadOf(group);
	const leadNames = lead.map((i) => label(i.m)).join(", ");
	items.forEach((item, at) => {
		const others = items.filter((x) => x !== item).map((x) => label(x.m));
		const shared = others.length
			? [
					`timing and easing shared with ${others.join(", ")}, set by ${leadNames}`,
				]
			: [];
		if (!lead.includes(item)) {
			const own = fitElements([[item]], ctx).fit;
			if ((fit.rmse[at] as number) > (own.rmse[0] as number) + JOIN_MARGIN) {
				placed.set(item, {
					fit: own,
					at: 0,
					group: 0,
					notes: [
						`fitted on its own: the timing of ${leadNames} leaves an rms gap of ${round(fit.rmse[at] as number)}`,
					],
				});
				return;
			}
		}
		placed.set(item, { fit, at, group: 0, notes: shared });
	});
}

const propertiesOf = (group: readonly PartialItem[]) =>
	group
		.map((i) => i.m.property)
		.sort()
		.join(",");

/**
 * Staggered siblings (indexed matches of one selector with the same partial properties) usually share easing and
 * duration; one fit with a delay each uses all their readings, and is kept when it costs no track more than noise.
 */
function placeSiblings(
	elements: readonly PartialItem[][],
	ctx: Context,
	placed: Map<PartialItem, Placed>,
): void {
	if (elements.length < 2) return;
	const props = propertiesOf(elements[0] as PartialItem[]);
	if (elements.some((g) => propertiesOf(g) !== props)) return;
	const { items, fit } = fitElements(elements, ctx);
	const fits = items.every((item, at) => {
		const own = placed.get(item) as Placed;
		return (
			(fit.rmse[at] as number) <= (own.fit.rmse[own.at] as number) + JOIN_MARGIN
		);
	});
	if (!fits) return;
	const names = elements.map((g) => elementOf((g[0] as PartialItem).m));
	let at = 0;
	elements.forEach((g, group) => {
		for (const item of g) {
			placed.set(item, {
				fit,
				at,
				group,
				notes: [
					`easing and duration shared by ${names.join(", ")}, each with its own start; ${(placed.get(item) as Placed).notes.join("; ")}`,
				],
			});
			at++;
		}
	});
}

/** A track whose placed fit still wants a start value beyond REACH gets a fit of its own within its visible range. */
function holdToVisibleRange(
	item: PartialItem,
	ctx: Context,
	placed: Map<PartialItem, Placed>,
): void {
	const { fit, at } = placed.get(item) as Placed;
	const wanted = fit.wanted[at] as number;
	const to = item.m.window.to;
	if (
		Math.abs(wanted - to) <=
		REACH * visibleChange(item.observed.obs, to) * 1.001
	)
		return;
	ctx.capped.set(item, wanted);
	placed.set(item, {
		fit: fitElements([[item]], ctx).fit,
		at: 0,
		group: 0,
		notes: ["fitted on its own within the visible range"],
	});
}

/** Partial fits for every motion whose start is not seen: per element, then across staggered siblings. */
export function fitPartialRows(
	items: readonly PartialItem[],
	frameMs: number,
	model: ObservationModel,
): Map<MovingProperty, PartialFit> {
	const ctx: Context = { frameMs, model, capped: new Map() };
	const bySelector = new Map<string, Map<string, PartialItem[]>>();
	for (const item of [...items].sort((a, b) => a.m.index - b.m.index)) {
		const elements = bySelector.get(item.m.selector) ?? new Map();
		const key = elementOf(item.m);
		elements.set(key, [...(elements.get(key) ?? []), item]);
		bySelector.set(item.m.selector, elements);
	}
	const placed = new Map<PartialItem, Placed>();
	for (const elements of bySelector.values()) {
		const groups = [...elements.values()];
		for (const g of groups) placeElement(g, ctx, placed);
		placeSiblings(groups, ctx, placed);
	}
	for (const item of items) holdToVisibleRange(item, ctx, placed);
	return new Map(
		items.map((i) => [i.m, result(i, placed.get(i) as Placed, ctx.capped)]),
	);
}
