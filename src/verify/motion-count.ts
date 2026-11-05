import type { MovingProperty, Track } from "../measure/elements.ts";
import type { SpecRow } from "../spec/schema.ts";
import type { CloneIndex } from "./clone.ts";
import { movement, ms, unitOf } from "./messages.ts";
import { holdsStill, pairMotions } from "./pairing.ts";
import type { RowVerdict } from "./schema.ts";

/** 1 for `sheet[0].y`, n for `sheet[0].y#n`. */
export const ordinalOf = (id: string): number => {
	const m = /#(\d+)$/.exec(id);
	return m ? Number(m[1]) : 1;
};

export const propertyKey = (
	r: Pick<SpecRow, "selector" | "index" | "property">,
) => `${r.selector}[${r.index}].${r.property}`;

/** How many motions the spec wants of each element and property: its highest row number. */
export function wantedMotions(rows: readonly SpecRow[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const r of rows) {
		const key = propertyKey(r);
		out.set(key, Math.max(out.get(key) ?? 0, ordinalOf(r.id)));
	}
	return out;
}

export const countMessage = (
	r: Pick<SpecRow, "selector" | "index" | "property">,
	got: number,
	want: number,
) =>
	`${r.selector}[${r.index}] ${r.property} has ${got} motion${got === 1 ? "" : "s"}, want ${want}${got > want ? ": remove the extra ones" : ""}`;

/** A row the clone makes enough motions for, none of them like it in start, direction and distance. */
export const unpairedMessage = (r: SpecRow) =>
	`${r.selector}[${r.index}] ${r.property}: no clone motion is like the one from ${ms(r.startMs)} ms (want ${movement(r.from, r.to, unitOf(r.property))} over ${ms(r.durationMs)} ms)`;

const motionText = (m: MovingProperty) =>
	`${movement(m.window.from, m.window.to, unitOf(m.property))} from ${ms(m.window.startMs)} ms over ${ms(m.window.durationMs)} ms`;

/**
 * Clone motions no row pairs with. One where the reference clearly holds the element still fails the row nearest it
 * in time; one where the reference does not show the element (lost, faded or cut off) is listed in `unpaired`.
 */
export function flagExtraMotions(
	verdicts: RowVerdict[],
	rows: readonly SpecRow[],
	idx: CloneIndex,
	ref: Track,
	unpaired: string[],
): void {
	for (const [key, want] of wantedMotions(rows)) {
		const all = idx.motions.get(key) ?? [];
		const same = rows.filter((r) => propertyKey(r) === key);
		if (want < 2) continue;
		for (const m of pairMotions(same, all).extra) {
			const label = `${m.selector}[${m.index}] ${m.property}`;
			if (!holdsStill(ref, m)) {
				unpaired.push(
					`${label}: the clone also moves ${motionText(m)}, where the reference does not show the element clearly (lost, faded or cut off), so this motion is not checked`,
				);
				continue;
			}
			const near = [...same].sort(
				(a, b) =>
					Math.abs(a.startMs - m.window.startMs) -
					Math.abs(b.startMs - m.window.startMs),
			)[0];
			const v = verdicts.find((x) => x.id === near?.id);
			if (!v) continue;
			v.failures.push(
				`${label} has ${all.length} motions, want ${want}: remove the one ${motionText(m)}, where the reference holds still`,
			);
			v.pass = false;
			v.message = v.failures.join("; ");
		}
	}
}
