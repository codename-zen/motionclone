import { deltaEHex, hexToLab } from "../look/colour.ts";
import type { LookFile, LookState } from "../look/schema.ts";
import { LAST, type Scope } from "./look-draft.ts";

// Rest frames whose backgrounds differ by more than this are different states of the design, such as light and dark.
const OTHER_STATE = 10;

export interface RestGroup {
	/** The rest frame the group's rows are read from: its latest, or the capture's last state. */
	state: LookState;
	scope: Scope;
	/** True for the group of the last state, whose rows keep their plain ids. */
	last: boolean;
	/** Every rest frame of the group, in time order. */
	members: LookState[];
}

/**
 * The reference's rest states, in the order they first appear, grouped by background. One group means one state
 * and rows without a state, as before; with more, each group is named light or dark by its background.
 */
export function restGroups(look: LookFile): RestGroup[] {
	const last = look.states.at(-1);
	if (!last) return [];
	const rest = look.states.filter((s) => s.rest || s === last);
	const groups: LookState[][] = [];
	for (const s of rest) {
		const g = groups.find(
			(x) =>
				deltaEHex((x[0] as LookState).pixels.background, s.pixels.background) <=
				OTHER_STATE,
		);
		if (g) g.push(s);
		else groups.push([s]);
	}
	if (groups.length <= 1)
		return [{ state: last, scope: LAST, last: true, members: rest }];
	const seen = new Map<string, number>();
	return groups.map((g) => {
		const isLast = g.includes(last);
		const state = isLast ? last : (g.at(-1) as LookState);
		const tone =
			hexToLab((g[0] as LookState).pixels.background).l >= 50
				? "light"
				: "dark";
		const n = (seen.get(tone) ?? 0) + 1;
		seen.set(tone, n);
		const name = n > 1 ? `${tone}${n}` : tone;
		const t = Math.round(state.t);
		return {
			state,
			last: isLast,
			members: g,
			scope: {
				state: { name, frame: state.frame, t },
				prefix: isLast ? "" : `${name}.`,
				suffix: isLast ? "" : ` (${name}, rest at ${t} ms)`,
			},
		};
	});
}
