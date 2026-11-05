import { fracOf, type Screen } from "../look/derive.ts";
import type { PageStyles, TypeLine } from "../look/schema.ts";
import { type LinePair, pairsAt } from "../look/type.ts";
import type { LookRow } from "../spec/look-schema.ts";
import { notComparable, sizeVerdict } from "./look-checks.ts";
import type { LookLine, LookRowVerdict } from "./schema.ts";

// Off-size lines named in a failing message; the rest are counted.
const MAX_NAMED = 3;
const MAX_TEXT = 24;

/** The words of the smallest text element whose box holds the middle of the line, from a style record. */
function textAt(
	styles: PageStyles | null,
	l: TypeLine,
	screen: Screen,
): string | null {
	if (!styles) return null;
	const cx = l.x + l.w / 2;
	const cy = l.y - l.cap / screen.h / 2;
	let best: { text: string; area: number } | null = null;
	for (const e of styles.elements) {
		if (e.textLength === 0) continue;
		const b = fracOf(e.box, screen);
		if (cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) continue;
		if (!best || b.w * b.h < best.area)
			best = { text: e.text.trim().slice(0, MAX_TEXT), area: b.w * b.h };
	}
	return best?.text || null;
}

const lineOf = (
	l: TypeLine,
	screen: Screen,
	styles: PageStyles | null,
): LookLine => ({
	x: Math.round(l.x * screen.w),
	y: Math.round(l.y * screen.h),
	cap: l.cap,
	text: textAt(styles, l, screen),
});

const place = (l: LookLine) =>
	`${l.text ? `"${l.text}" ` : ""}at x ${l.x}, baseline y ${l.y} px`;

export interface TypeContext {
	screen: Screen;
	/** Style records of the reference and the clone at the row's frame, when the captures have them there. */
	refStyles: PageStyles | null;
	cloneStyles: PageStyles | null;
}

/** A type row against the clone's lines in the places of its lines; the message names the lines it compares. */
export function typeVerdict(
	r: LookRow,
	lines: readonly TypeLine[],
	ctx: TypeContext,
): LookRowVerdict {
	const pairs = pairsAt(r.lines, lines, ctx.screen.h);
	const named = (p: LinePair) => ({
		reference: lineOf(p.want, ctx.screen, ctx.refStyles),
		clone: lineOf(p.got, ctx.screen, ctx.cloneStyles),
	});
	const paired = new Set(pairs.map((p) => p.want));
	const all = [
		...pairs.map(named),
		...r.lines
			.filter((l) => !paired.has(l))
			.map((l) => ({
				reference: lineOf(l, ctx.screen, ctx.refStyles),
				clone: null,
			})),
	];
	const first = all[0]?.reference;
	if (pairs.length === 0)
		return {
			...notComparable(
				r,
				`no matching text line in the clone${first ? `; the reference line is ${place(first)}` : ""}`,
			),
			lines: all,
		};
	const mid = [...pairs].sort((a, b) => a.got.cap - b.got.cap)[
		pairs.length >> 1
	] as LinePair;
	const v = sizeVerdict(r, mid.got.cap);
	if (v.pass) {
		const m = named(mid);
		return {
			...v,
			lines: all,
			message: `${v.message}, line ${place(m.reference)} (clone line ${place(m.clone)})`,
		};
	}
	const tol = r.tolerances.size;
	const off = pairs
		.filter((p) => Math.abs(p.got.cap / p.want.cap - 1) > tol)
		.map(named);
	const shown = off
		.slice(0, MAX_NAMED)
		.map(
			(p) =>
				`the line ${place(p.reference)} (${p.reference.cap} px) reads ${p.clone.cap} px in the clone ${place(p.clone)}`,
		);
	if (off.length > MAX_NAMED)
		shown.push(`${off.length - MAX_NAMED} more lines are off`);
	return {
		...v,
		lines: all,
		message: [v.message, ...shown].join("; "),
	};
}
