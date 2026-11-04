import type { ClipRect } from "../capture/options.ts";
import { isOpaque } from "../look/colour.ts";
import {
	bodyEntry,
	fracOf,
	mainTextColour,
	pixelAccents,
	type Screen,
	styleAccents,
	styleBlocks,
	titleEntry,
} from "../look/derive.ts";
import { readLook } from "../look/file.ts";
import type {
	LookFile,
	PageStyles,
	PixelLook,
	StyleEntry,
	TypeLine,
} from "../look/schema.ts";
import { inBox, ranked, sizeGroups } from "../look/type.ts";
import {
	BACKGROUND_DELTA_E,
	DEFAULT_LOOK_TOLERANCES,
	type LookRow,
	LookSpec,
} from "./look-schema.ts";

type Draft = Pick<LookRow, "id" | "label" | "measure"> &
	Partial<Omit<LookRow, "method">>;

const BACKGROUND = { ...DEFAULT_LOOK_TOLERANCES, deltaE: BACKGROUND_DELTA_E };
const MAX_BLOCK_ROWS = 8;

const rowsOf = (method: LookRow["method"], drafts: Draft[]): LookRow[] =>
	drafts.map((d) => ({
		target: null,
		role: null,
		colour: null,
		px: null,
		box: null,
		share: null,
		notes: [],
		...d,
		lines: d.lines ?? [],
		method,
		tolerances: { ...DEFAULT_LOOK_TOLERANCES, ...d.tolerances },
	}));

const example = (e: StyleEntry) =>
	`${e.tag} "${e.text.slice(0, 24)}", weight ${e.fontWeight}, ${e.fontFamily}`;

export function parseKey(
	key: string,
): { selector: string; index: number } | null {
	const m = /^(.*)\[(\d+)\]$/.exec(key);
	return m ? { selector: m[1] as string, index: Number(m[2]) } : null;
}

function trackedDrafts(styles: PageStyles, screen: Screen): Draft[] {
	return Object.entries(styles.tracked).flatMap(([selector, list]) =>
		list.flatMap((at, index) => {
			const e = styles.elements[at];
			if (at < 0 || !e) return [];
			const key = `${selector}[${index}]`;
			const target = { selector, index };
			const own = isOpaque(e.background);
			const head = (measure: Draft["measure"], name: string, label: string) =>
				({
					id: `${key}.look.${name}`,
					label: `${key} ${label}`,
					measure,
					target,
				}) as const;
			const out: Draft[] = [
				{ ...head("element-box", "box", "box"), box: fracOf(e.box, screen) },
			];
			if (e.textLength > 0)
				out.push(
					{
						...head("element-font-size", "font-size", "font size"),
						px: e.fontSize,
					},
					{
						...head("element-colour", "colour", "text colour"),
						colour: e.color.slice(0, 7),
					},
				);
			if (own)
				out.push({
					...head("element-background", "background", "background"),
					colour: e.background.slice(0, 7),
					tolerances: BACKGROUND,
				});
			if (e.radius > 0 && (own || e.border))
				out.push({
					...head("element-radius", "radius", "corner radius"),
					px: e.radius,
				});
			return out;
		}),
	);
}

function pageRows(styles: PageStyles, screen: Screen): LookRow[] {
	const out: Draft[] = [
		{
			id: "look.background",
			label: "page background",
			measure: "page-background",
			colour: styles.background,
			tolerances: BACKGROUND,
		},
	];
	const text = mainTextColour(styles);
	if (text)
		out.push({
			id: "look.text",
			label: "main text colour",
			measure: "text-colour",
			colour: text,
		});
	for (const [k, a] of styleAccents(styles, screen).entries())
		out.push({
			id: `look.accent#${k + 1}`,
			label: "accent colour",
			measure: "accent",
			colour: a.hex,
			share: a.share,
		});
	const title = titleEntry(styles);
	const body = bodyEntry(styles);
	if (title)
		out.push({
			id: "look.type.title",
			label: "title font size",
			measure: "font-size",
			role: "title",
			px: title.fontSize,
			notes: [`largest type: ${example(title)}`],
		});
	if (body && body.fontSize !== title?.fontSize)
		out.push({
			id: "look.type.body",
			label: "body text font size",
			measure: "font-size",
			role: "body",
			px: body.fontSize,
			notes: [`most text: ${example(body)}`],
		});
	out.push(...trackedDrafts(styles, screen));
	const skip = new Set(Object.values(styles.tracked).flat());
	for (const [k, b] of styleBlocks(styles, screen, skip).entries())
		out.push({
			id: `look.block#${k + 1}`,
			label: `block ${styles.elements[b.index]?.name ?? ""}`.trim(),
			measure: "block",
			colour: b.hex,
			box: b.box,
		});
	return rowsOf("style", out);
}

// Cap height is about 0.7 of the font size in common sans and serif faces.
const CAP_PER_EM = 0.7;

// Each size of the lines in one place (a region, or the screen outside every region), largest first.
function typeDrafts(
	lines: readonly TypeLine[],
	all: readonly TypeLine[],
	key: string | null,
	screen: Screen,
): Draft[] {
	const head = key ? `${key}.look` : "look";
	const lead = key ? `${key} ` : "";
	return sizeGroups(lines).map((g, k) => ({
		id: `${head}.type#${k + 1}`,
		label: `${lead}text cap height`,
		measure: "text-height",
		target: key ? parseKey(key) : null,
		px: g.px,
		lines: g.lines.map((l) => ranked(l, all)),
		notes: [
			`${g.lines.length} text line${g.lines.length === 1 ? "" : "s"} of this size, the first with its baseline at y ${Math.round((g.lines[0]?.y ?? 0) * screen.h)} px; cap height ${g.px} px is about ${Math.round(g.px / CAP_PER_EM)} px type in a common face`,
		],
	}));
}

function videoRows(p: PixelLook, screen: Screen): LookRow[] {
	const out: Draft[] = [
		{
			id: "look.background",
			label: "page background",
			measure: "page-background",
			colour: p.background,
			tolerances: BACKGROUND,
		},
	];
	if (p.text)
		out.push({
			id: "look.text",
			label: "main text colour",
			measure: "text-colour",
			colour: p.text,
		});
	for (const [k, a] of pixelAccents(p).entries())
		out.push({
			id: `look.accent#${k + 1}`,
			label: "accent colour",
			measure: "accent",
			colour: a.hex,
			share: a.share,
		});
	const boxes = p.regions.map((r) => fracOf(r.box, screen));
	const regionOf = (l: TypeLine) => boxes.findIndex((b) => inBox(l, b));
	out.push(
		...typeDrafts(
			p.lines.filter((l) => regionOf(l) < 0),
			p.lines,
			null,
			screen,
		),
	);
	for (const [i, r] of p.regions.entries()) {
		const target = parseKey(r.key);
		if (!target) continue;
		out.push({
			id: `${r.key}.look.background`,
			label: `${r.key} background`,
			measure: "region-background",
			target,
			colour: r.background,
			tolerances: BACKGROUND,
		});
		out.push(
			...typeDrafts(
				p.lines.filter((l) => regionOf(l) === i),
				p.lines,
				r.key,
				screen,
			),
		);
	}
	for (const [k, b] of p.blocks.slice(0, MAX_BLOCK_ROWS).entries())
		out.push({
			id: `look.block#${k + 1}`,
			label: "block",
			measure: "block",
			colour: b.hex,
			box: { x: b.x, y: b.y, w: b.w, h: b.h },
		});
	return rowsOf("pixels", out);
}

/** Look rows from the reference's last rest frame; the structure score covers all its rest frames. */
export function draftLook(look: LookFile, clip: ClipRect): LookSpec {
	const last = look.states.at(-1);
	if (!last) throw new Error("look.json has no states");
	const screen = { x: clip.x, y: clip.y, w: clip.width, h: clip.height };
	return LookSpec.parse({
		source: look.source,
		frames: look.states
			.filter((s) => s.rest || s.label === "last")
			.map((s) => ({ label: s.label, frame: s.frame, t: s.t })),
		rows: last.page
			? pageRows(last.page, screen)
			: videoRows(last.pixels, screen),
	});
}

/** The look section of a capture directory, or null when it has no look.json. */
export async function draftLookOf(
	dir: string,
	clip: ClipRect,
): Promise<LookSpec | null> {
	const look = await readLook(dir);
	return look ? draftLook(look, clip) : null;
}
