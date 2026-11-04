import type { SpecRow } from "../spec/schema.ts";
import type { CloneIndex } from "./clone.ts";
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

/** A clone that moves an element more often than the spec fails on that property's last row. */
export function flagExtraMotions(
	verdicts: RowVerdict[],
	rows: readonly SpecRow[],
	idx: CloneIndex,
): void {
	for (const [key, want] of wantedMotions(rows)) {
		const got = idx.motions.get(key)?.length ?? 0;
		if (want < 2 || got <= want) continue;
		const last = rows.find(
			(r) => propertyKey(r) === key && ordinalOf(r.id) === want,
		);
		const v = verdicts.find((x) => x.id === last?.id);
		if (!last || !v) continue;
		v.failures.push(countMessage(last, got, want));
		v.pass = false;
		v.message = v.failures.join("; ");
	}
}
