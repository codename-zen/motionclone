import type { ClipRect } from "../capture/options.ts";
import { isOpaque } from "../look/colour.ts";
import {
	bodyEntry,
	fracOf,
	mainTextColour,
	type Screen,
	styleAccents,
	styleBlocks,
	titleEntry,
} from "../look/derive.ts";
import { readLook } from "../look/file.ts";
import type { LookFile, PageStyles, StyleEntry } from "../look/schema.ts";
import { BACKGROUND, type Draft, rowsOf, type Scope } from "./look-draft.ts";
import { pixelDrafts } from "./look-pixels.ts";
import { type LookRow, LookSpec } from "./look-schema.ts";
import { restGroups } from "./look-states.ts";

const example = (e: StyleEntry) =>
	`${e.tag} "${e.text.slice(0, 24)}", weight ${e.fontWeight}, ${e.fontFamily}`;

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

function pageRows(styles: PageStyles, screen: Screen, scope: Scope): LookRow[] {
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
	return rowsOf("style", out, scope);
}

/**
 * Look rows from the last rest frame of each of the reference's rest states: computed styles for the last state of a
 * page, pixels otherwise. The structure score covers every rest frame.
 */
export function draftLook(look: LookFile, clip: ClipRect): LookSpec {
	const groups = restGroups(look);
	if (groups.length === 0) throw new Error("look.json has no states");
	const screen = { x: clip.x, y: clip.y, w: clip.width, h: clip.height };
	return LookSpec.parse({
		source: look.source,
		frames: look.states
			.filter((s) => s.rest || s.label === "last")
			.map((s) => ({ label: s.label, frame: s.frame, t: s.t })),
		rows: groups.flatMap(({ state, scope, last }) =>
			last && state.page
				? pageRows(state.page, screen, scope)
				: rowsOf("pixels", pixelDrafts(state.pixels, screen), scope),
		),
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
