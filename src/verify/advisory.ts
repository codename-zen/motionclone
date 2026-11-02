import type { SpecRow } from "../spec/schema.ts";

/** Why a low-confidence row is advisory, from the evidence the spec recorded; null for rows that count. */
export function advisoryReason(row: SpecRow): string | null {
	if (row.confidence !== "low") return null;
	const weak = row.support?.weak ?? [];
	return weak.length
		? weak.join("; ")
		: "confidence low in the spec, with no evidence recorded";
}
