import { deltaEHex } from "../look/colour.ts";
import { fracOf, pixelAccents, type Screen } from "../look/derive.ts";
import type { Block, PixelLook, TypeLine } from "../look/schema.ts";
import { inBox, ranked, sizeGroups } from "../look/type.ts";
import {
	BACKGROUND,
	type Draft,
	MAX_BLOCK_ROWS,
	parseKey,
} from "./look-draft.ts";
import { DEFAULT_LOOK_TOLERANCES, RADIUS_TOLERANCE } from "./look-schema.ts";

// Cap height is about 0.7 of the font size in common sans and serif faces.
const CAP_PER_EM = 0.7;
// Text of one colour holds this share of the ink at least; text in several colours gets no text colour row.
const UNIFORM_TEXT = 0.6;
// Corners rounder than this, CSS px, get a radius row.
const MIN_RADIUS = 2;

/** Which glyphs a size's cap heights come from, in words. */
function basisNote(lines: readonly TypeLine[]): string {
	const caps = lines.filter((l) => l.basis === "capitals");
	const glyphs = caps.reduce((s, l) => s + l.glyphs, 0);
	const parts: string[] = [];
	if (caps.length > 0)
		parts.push(
			`measured on ${glyphs} capital or digit glyph${glyphs === 1 ? "" : "s"} of ${caps.length} line${caps.length === 1 ? "" : "s"}`,
		);
	const lower = lines.length - caps.length;
	if (lower > 0)
		parts.push(
			`${lower} line${lower === 1 ? "" : "s"} without clear capitals read from ascenders or the x-height`,
		);
	return parts.join("; ");
}

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
			basisNote(g.lines),
		],
	}));
}

function panelDrafts(p: PixelLook, screen: Screen): Draft[] {
	const panel = p.panel;
	if (!panel) return [];
	const at = `${Math.round(panel.y * screen.h)} px`;
	const out: Draft[] = [
		{
			id: "look.panel.top",
			label: "large panel top edge",
			measure: "panel-edge",
			colour: panel.hex,
			box: { x: panel.x, y: panel.y, w: panel.w, h: 1 - panel.y },
			notes: [
				`the ${panel.hex} panel ${Math.round(panel.w * 100)} % of the screen wide starts at y ${at}`,
			],
		},
	];
	if (panel.radius >= MIN_RADIUS)
		out.push({
			id: "look.panel.radius",
			label: "large panel corner radius",
			measure: "panel-radius",
			px: panel.radius,
			tolerances: { ...DEFAULT_LOOK_TOLERANCES, size: RADIUS_TOLERANCE },
			notes: ["read from the curvature of its top corners"],
		});
	return out;
}

const inside = (a: Block, b: Block) =>
	a !== b &&
	a.x >= b.x &&
	a.y >= b.y &&
	a.x + a.w <= b.x + b.w &&
	a.y + a.h <= b.y + b.h;

/**
 * Blocks with a fill of their own. One the colour of what surrounds it (the page, or a larger block it lies in) is
 * drawn by a hairline border alone, which a video blurs wider than a crisp rebuild draws it, so it gets no row.
 */
const outlined = (p: PixelLook) =>
	p.blocks.filter(
		(b) =>
			deltaEHex(b.hex, p.background) > BACKGROUND.deltaE &&
			!p.blocks.some(
				(o) => inside(b, o) && deltaEHex(b.hex, o.hex) <= BACKGROUND.deltaE,
			),
	);

/** Rows read from one rest frame's pixels. */
export function pixelDrafts(p: PixelLook, screen: Screen): Draft[] {
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
	if (p.outsideText && (p.outsideTextShare ?? 0) >= UNIFORM_TEXT)
		out.push({
			id: "look.outside.text",
			label: "text colour outside the regions",
			measure: "outside-text-colour",
			colour: p.outsideText,
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
		if (r.text && (r.textShare ?? 0) >= UNIFORM_TEXT)
			out.push({
				id: `${r.key}.look.text`,
				label: `${r.key} text colour`,
				measure: "region-text-colour",
				target,
				colour: r.text,
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
	out.push(...panelDrafts(p, screen));
	for (const [k, b] of outlined(p).slice(0, MAX_BLOCK_ROWS).entries())
		out.push({
			id: `look.block#${k + 1}`,
			label: "block",
			measure: "block",
			colour: b.hex,
			box: { x: b.x, y: b.y, w: b.w, h: b.h },
		});
	return out;
}
