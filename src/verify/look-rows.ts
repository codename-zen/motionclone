import {
	bodyEntry,
	fracOf,
	mainTextColour,
	type Screen,
	styleBlocks,
	styleSurfaceColours,
	titleEntry,
	trackedEntry,
} from "../look/derive.ts";
import type { PageStyles, PixelLook, StyleEntry } from "../look/schema.ts";
import type { LookRow } from "../spec/look-schema.ts";
import {
	accentVerdict,
	blockVerdict,
	boxVerdict,
	colourVerdict,
	missing,
	sizeVerdict,
} from "./look-checks.ts";
import type { LookRowVerdict } from "./schema.ts";

/** What the clone shows on the reference's last rest frame, read the way the reference was. */
export interface CloneLook {
	/** Null when the clone capture has no style record. */
	styles: PageStyles | null;
	pixels: PixelLook | null;
	screen: Screen;
	/** The clone selector and index that stand in for a reference element. */
	target(selector: string, index: number): { selector: string; index: number };
}

function styleValue(
	r: LookRow,
	s: PageStyles,
	clone: CloneLook,
): LookRowVerdict {
	switch (r.measure) {
		case "page-background":
			return colourVerdict(r, s.background);
		case "text-colour": {
			const c = mainTextColour(s);
			return c ? colourVerdict(r, c) : missing(r, "the clone shows no text");
		}
		case "accent":
			return accentVerdict(r, styleSurfaceColours(s));
		case "font-size": {
			const e = r.role === "title" ? titleEntry(s) : bodyEntry(s);
			return e
				? sizeVerdict(r, e.fontSize)
				: missing(r, "the clone shows no text");
		}
		case "block":
			return blockVerdict(
				r,
				styleBlocks(s, clone.screen).map((b) => ({ box: b.box, hex: b.hex })),
				clone.screen,
			);
		default:
			break;
	}
	const target = r.target;
	if (!target) return missing(r, "the row names no element");
	const t = clone.target(target.selector, target.index);
	const e = s.elements[trackedEntry(s, t.selector, t.index)] as
		| StyleEntry
		| undefined;
	if (!e)
		return missing(
			r,
			`${t.selector}[${t.index}] is not visible on the clone's last frame`,
		);
	switch (r.measure) {
		case "element-font-size":
			return sizeVerdict(r, e.fontSize);
		case "element-colour":
			return colourVerdict(r, e.color.slice(0, 7));
		case "element-background":
			return colourVerdict(r, e.effectiveBackground);
		case "element-radius":
			return sizeVerdict(r, e.radius);
		default:
			return boxVerdict(r, fracOf(e.box, clone.screen), clone.screen);
	}
}

function pixelValue(
	r: LookRow,
	p: PixelLook,
	clone: CloneLook,
): LookRowVerdict {
	switch (r.measure) {
		case "page-background":
			return colourVerdict(r, p.background);
		case "text-colour":
			return p.text
				? colourVerdict(r, p.text)
				: missing(r, "the clone shows no text lines");
		case "accent":
			return accentVerdict(
				r,
				[...p.surfaces, ...p.palette].map((s) => s.hex),
			);
		case "region-background": {
			const key = r.target ? `${r.target.selector}[${r.target.index}]` : "";
			const reg = p.regions.find((x) => x.key === key);
			return reg
				? colourVerdict(r, reg.background)
				: missing(
						r,
						`${key} is not tracked in the clone; capture it with --track and --map`,
					);
		}
		case "block":
			return blockVerdict(
				r,
				p.blocks.map((b) => ({
					box: { x: b.x, y: b.y, w: b.w, h: b.h },
					hex: b.hex,
				})),
				clone.screen,
			);
		default:
			return missing(r, `${r.measure} is not measured from pixels`);
	}
}

/** Check one look row against the clone, measured the way the reference was. */
export function checkLookRow(r: LookRow, clone: CloneLook): LookRowVerdict {
	if (r.method === "pixels")
		return clone.pixels
			? pixelValue(r, clone.pixels, clone)
			: missing(r, "the clone's frames could not be read");
	return clone.styles
		? styleValue(r, clone.styles, clone)
		: missing(
				r,
				"the clone capture has no look.json; capture it again with this version",
			);
}
