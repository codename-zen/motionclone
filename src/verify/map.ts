import type { AnimationRecord } from "../capture/types.ts";
import type { Track } from "../measure/elements.ts";

interface Ref {
	selector: string;
	index: number | null;
}

export interface MapEntry {
	ref: Ref;
	clone: Ref;
}

function side(text: string, what: string, spec: string): Ref {
	const t = text.trim();
	const m = /^(.*?)(?:\[(\d+)\])?$/.exec(t);
	const selector = (m?.[1] ?? "").trim();
	if (!selector) throw new Error(`--map "${spec}": missing ${what} name`);
	return { selector, index: m?.[2] === undefined ? null : Number(m[2]) };
}

/** "card=.card" maps every index; "card[2]=.x[0]" maps one element. */
export function parseMap(specs: string[]): MapEntry[] {
	return specs.map((spec) => {
		const eq = spec.indexOf("=");
		if (eq < 0)
			throw new Error(
				`--map "${spec}": use refName=cloneSelector, like card=.card`,
			);
		const ref = side(spec.slice(0, eq), "reference", spec);
		const clone = side(spec.slice(eq + 1), "clone selector", spec);
		if ((ref.index === null) !== (clone.index === null))
			throw new Error(
				`--map "${spec}": give an index on both sides or on neither`,
			);
		return { ref, clone };
	});
}

/** Clone selectors that stand in for a reference selector; the selector itself when unmapped. */
export function cloneSelectorsFor(map: MapEntry[], selector: string): string[] {
	const hits = map.filter((m) => m.ref.selector === selector);
	return hits.length
		? [...new Set(hits.map((m) => m.clone.selector))]
		: [selector];
}

/** The clone track with mapped elements renamed to the reference's selectors and indexes. */
export function renameTrack(track: Track, map: MapEntry[]): Track {
	if (map.length === 0) return track;
	const mapped = new Set(map.map((m) => m.clone.selector));
	const refs: string[] = [];
	const frames = track.frames.map((f) => {
		const elements: typeof f.elements = {};
		for (const [sel, list] of Object.entries(f.elements))
			if (!mapped.has(sel)) elements[sel] = list;
		for (const m of map) {
			const found = (f.elements[m.clone.selector] ?? []).filter(
				(e) => m.clone.index === null || e.index === m.clone.index,
			);
			if (found.length === 0) continue;
			const renamed = found.map((e) => ({
				...e,
				index: m.ref.index ?? e.index,
			}));
			elements[m.ref.selector] = [
				...(elements[m.ref.selector] ?? []),
				...renamed,
			].sort((a, b) => a.index - b.index);
		}
		return { ...f, elements };
	});
	for (const m of map) refs.push(m.ref.selector);
	return {
		...track,
		selectors: [
			...track.selectors.filter((s) => !mapped.has(s)),
			...new Set(refs),
		],
		frames,
	};
}

/** The clone's animations with their tracked matches renamed the way renameTrack renames elements. */
export function renameAnimations(
	animations: AnimationRecord[],
	map: MapEntry[],
): AnimationRecord[] {
	if (map.length === 0) return animations;
	const mapped = new Set(map.map((m) => m.clone.selector));
	return animations.map((a) => ({
		...a,
		tracked: a.tracked.flatMap((t) =>
			mapped.has(t.selector)
				? map
						.filter(
							(m) =>
								m.clone.selector === t.selector &&
								(m.clone.index === null || m.clone.index === t.index),
						)
						.map((m) => ({
							selector: m.ref.selector,
							index: m.ref.index ?? t.index,
						}))
				: [t],
		),
	}));
}
