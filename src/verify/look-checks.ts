import { deltaEHex } from "../look/colour.ts";
import { iou, type Screen } from "../look/derive.ts";
import type { FracBox } from "../look/schema.ts";
import type { LookRow } from "../spec/look-schema.ts";
import type { LookRowVerdict } from "./schema.ts";

const fixed = (v: number, d = 1) => Number(v.toFixed(d));
const pct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)} %`;

type Base = Pick<LookRowVerdict, "id" | "label" | "measure" | "method">;
const base = (r: LookRow): Base => ({
	id: r.id,
	label: r.label,
	measure: r.measure,
	method: r.method,
});

export function missing(r: LookRow, why: string): LookRowVerdict {
	const want = r.colour ?? (r.px !== null ? `${r.px} px` : "a box");
	return {
		...base(r),
		pass: false,
		want,
		got: null,
		diff: null,
		tol: 0,
		unit: "tolerance",
		message: `${r.label}: ${why}`,
	};
}

export function colourVerdict(
	r: LookRow,
	got: string,
	what = r.label,
): LookRowVerdict {
	const want = r.colour as string;
	const d = fixed(deltaEHex(got, want));
	const tol = r.tolerances.deltaE;
	const pass = d <= tol;
	return {
		...base(r),
		pass,
		want,
		got,
		diff: d,
		tol,
		unit: "deltaE",
		message: pass
			? `${what} ${got} matches ${want} (ΔE ${d})`
			: `${what} is ${got}, want ${want} (ΔE ${d} > ${tol})`,
	};
}

export function sizeVerdict(r: LookRow, got: number): LookRowVerdict {
	const want = r.px as number;
	const rel = want ? got / want - 1 : got === 0 ? 0 : 1;
	const tol = r.tolerances.size;
	const pass = Math.abs(rel) <= tol + 1e-9;
	return {
		...base(r),
		pass,
		want: `${want} px`,
		got: `${fixed(got, 2)} px`,
		diff: fixed(rel, 4),
		tol,
		unit: "relative",
		message: pass
			? `${r.label} ${fixed(got, 2)} px matches ${want} px`
			: `${r.label} ${fixed(got, 2)} px, want ${want} px (${pct(rel)}, allowed ±${Math.round(tol * 100)} %)`,
	};
}

export function boxVerdict(
	r: LookRow,
	got: FracBox,
	screen: Screen,
	colour?: { hex: string; d: number },
): LookRowVerdict {
	const want = r.box as FracBox;
	const t = r.tolerances;
	const px = (b: FracBox) =>
		`${Math.round(b.w * screen.w)}x${Math.round(b.h * screen.h)} px at ${Math.round(b.x * screen.w)},${Math.round(b.y * screen.h)}`;
	const parts: [string, number, number, string][] = [
		[
			"x",
			Math.abs(got.x - want.x),
			t.position,
			`x off by ${fixed((got.x - want.x) * 100)} % of the screen`,
		],
		[
			"y",
			Math.abs(got.y - want.y),
			t.position,
			`y off by ${fixed((got.y - want.y) * 100)} % of the screen`,
		],
		[
			"w",
			Math.abs(got.w / want.w - 1),
			t.size,
			`width ${pct(got.w / want.w - 1)}`,
		],
		[
			"h",
			Math.abs(got.h / want.h - 1),
			t.size,
			`height ${pct(got.h / want.h - 1)}`,
		],
	];
	const bad = parts.filter(([, v, tol]) => v > tol + 1e-9).map((p) => p[3]);
	if (colour && colour.d > t.deltaE)
		bad.push(`colour ${colour.hex}, ΔE ${fixed(colour.d)} > ${t.deltaE}`);
	const worst = Math.max(...parts.map(([, v, tol]) => (tol ? v / tol : 0)));
	const pass = bad.length === 0;
	const name = r.measure === "block" ? `${r.label} ${r.colour}` : r.label;
	return {
		...base(r),
		pass,
		want: px(want),
		got: px(got),
		diff: fixed(worst, 2),
		tol: 1,
		unit: "tolerance",
		message: pass
			? `${name} ${px(got)} matches ${px(want)}`
			: `${name} is ${px(got)}, want ${px(want)} (${bad.join(", ")})`,
	};
}

function nearest(want: string, colours: string[]): string | null {
	let best: string | null = null;
	let bestD = Number.POSITIVE_INFINITY;
	for (const c of colours) {
		const d = deltaEHex(c, want);
		if (d < bestD) {
			bestD = d;
			best = c;
		}
	}
	return best;
}

export function accentVerdict(r: LookRow, colours: string[]): LookRowVerdict {
	const got = nearest(r.colour as string, colours);
	if (!got) return missing(r, "the clone shows no flat surfaces");
	const v = colourVerdict(r, got);
	const share =
		r.share === null ? "" : ` (${fixed(r.share * 100)} % of the screen)`;
	return v.pass
		? v
		: {
				...v,
				message: `accent colour ${r.colour}${share} is missing: the closest surface colour is ${got} (ΔE ${v.diff} > ${v.tol})`,
			};
}

export function blockVerdict(
	r: LookRow,
	blocks: { box: FracBox; hex: string }[],
	screen: Screen,
): LookRowVerdict {
	const want = r.box as FracBox;
	const scored = blocks.map((b) => ({
		...b,
		iou: iou(b.box, want),
		d: deltaEHex(b.hex, r.colour as string),
	}));
	const same = scored.filter((b) => b.d <= r.tolerances.deltaE && b.iou > 0);
	const pick = (list: typeof scored) => list.sort((a, b) => b.iou - a.iou)[0];
	const best = pick(same) ?? pick(scored.filter((b) => b.iou > 0));
	if (!best)
		return missing(
			r,
			`the clone has no flat ${r.colour} block near ${Math.round(want.x * screen.w)},${Math.round(want.y * screen.h)} (${Math.round(want.w * screen.w)}x${Math.round(want.h * screen.h)} px)`,
		);
	return boxVerdict(r, best.box, screen, { hex: best.hex, d: best.d });
}
