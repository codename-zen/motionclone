import {
	BACKGROUND_DELTA_E,
	DEFAULT_LOOK_TOLERANCES,
	type LookRow,
	type LookStateRef,
} from "./look-schema.ts";

export type Draft = Pick<LookRow, "id" | "label" | "measure"> &
	Partial<Omit<LookRow, "method">>;

export const BACKGROUND = {
	...DEFAULT_LOOK_TOLERANCES,
	deltaE: BACKGROUND_DELTA_E,
};
export const MAX_BLOCK_ROWS = 8;

/** Where drafted rows belong: the last rest state keeps plain ids, other states prefix them with their name. */
export interface Scope {
	state: LookStateRef | null;
	/** "" or "dark.". */
	prefix: string;
	/** "" or " (dark, rest at 1536 ms)". */
	suffix: string;
}

export const LAST: Scope = { state: null, prefix: "", suffix: "" };

export const rowsOf = (
	method: LookRow["method"],
	drafts: Draft[],
	scope: Scope = LAST,
): LookRow[] =>
	drafts.map((d) => ({
		target: null,
		role: null,
		colour: null,
		px: null,
		box: null,
		share: null,
		notes: [],
		...d,
		id: `${scope.prefix}${d.id}`,
		label: `${d.label}${scope.suffix}`,
		lines: d.lines ?? [],
		method,
		tolerances: { ...DEFAULT_LOOK_TOLERANCES, ...d.tolerances },
		state: scope.state,
	}));

export function parseKey(
	key: string,
): { selector: string; index: number } | null {
	const m = /^(.*)\[(\d+)\]$/.exec(key);
	return m ? { selector: m[1] as string, index: Number(m[2]) } : null;
}
