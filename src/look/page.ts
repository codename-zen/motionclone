import type { Page } from "playwright";
import type { ClipRect } from "../capture/options.ts";
import type { PageStyles, StyleEntry } from "./schema.ts";

export const MAX_LOOK_ELEMENTS = 600;

interface DumpInput {
	target: string | null;
	tracked: string[];
	crop: ClipRect;
	max: number;
}

// Runs in the page; must stay self-contained because Playwright serializes it.
function dumpInPage({ target, tracked, crop, max }: DumpInput): PageStyles {
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext("2d", {
		willReadFrequently: true,
	}) as CanvasRenderingContext2D;
	const colours = new Map<string, string>();
	const hex2 = (v: number) => v.toString(16).padStart(2, "0");
	const toHex = (css: string): string => {
		const hit = colours.get(css);
		if (hit) return hit;
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = "#000";
		ctx.fillStyle = css;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1)
			.data as unknown as number[];
		const out = `#${hex2(r as number)}${hex2(g as number)}${hex2(b as number)}${(a as number) < 255 ? hex2(a as number) : ""}`;
		colours.set(css, out);
		return out;
	};
	const rgba = (hex: string) => {
		const v = Number.parseInt(hex.slice(1, 7), 16);
		const a = hex.length > 7 ? Number.parseInt(hex.slice(7), 16) / 255 : 1;
		return [(v >> 16) & 255, (v >> 8) & 255, v & 255, a] as const;
	};
	const over = (top: string, under: string): string => {
		const [r, g, b, a] = rgba(top);
		if (a >= 1) return top.slice(0, 7);
		const [ur, ug, ub] = rgba(under);
		const mix = (x: number, y: number) => hex2(Math.round(x * a + y * (1 - a)));
		return `#${mix(r, ur)}${mix(g, ug)}${mix(b, ub)}`;
	};

	const GENERIC = new Set([
		"serif",
		"sans-serif",
		"monospace",
		"cursive",
		"fantasy",
		"system-ui",
		"ui-serif",
		"ui-sans-serif",
		"ui-monospace",
		"ui-rounded",
		"math",
		"emoji",
		"fangsong",
	]);
	const families = new Map<string, string>();
	const PROBE = "mmmmmmmmmmlli1WQ@#";
	const width = (font: string) => {
		ctx.font = font;
		return ctx.measureText(PROBE).width;
	};
	const available = (family: string) =>
		["monospace", "serif"].some(
			(base) => width(`72px "${family}", ${base}`) !== width(`72px ${base}`),
		);
	const resolveFamily = (list: string): string => {
		const hit = families.get(list);
		if (hit !== undefined) return hit;
		const names = list
			.split(",")
			.map((s) => s.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
		const found =
			names.find((n) => GENERIC.has(n.toLowerCase()) || available(n)) ??
			names.at(-1) ??
			"";
		families.set(list, found);
		return found;
	};
	const px = (v: string) => {
		const n = Number.parseFloat(v);
		return Number.isFinite(n) ? n : 0;
	};
	const r2 = (v: number) => Math.round(v * 100) / 100;

	const rootBg = (): string => {
		for (const el of [document.documentElement, document.body]) {
			if (!el) continue;
			const bg = toHex(getComputedStyle(el).backgroundColor);
			if (rgba(bg)[3] > 0) return over(bg, "#ffffff");
		}
		return "#ffffff";
	};
	const root = target
		? document.querySelector(target)
		: (document.body ?? document.documentElement);
	const canvasBg = rootBg();
	let background = canvasBg;
	const chain: Element[] = [];
	for (let e = root?.parentElement ?? null; e; e = e.parentElement)
		chain.unshift(e);
	for (const e of chain) {
		const bg = toHex(getComputedStyle(e).backgroundColor);
		if (e !== document.documentElement && rgba(bg)[3] > 0)
			background = over(bg, background);
	}
	let opacity0 = 1;
	for (const e of chain) opacity0 *= px(getComputedStyle(e).opacity);

	const elements: StyleEntry[] = [];
	const index = new Map<Element, number>();
	let truncated = false;
	const ownText = (el: Element) =>
		Array.from(el.childNodes)
			.filter((n) => n.nodeType === Node.TEXT_NODE)
			.map((n) => n.textContent ?? "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
	const borderOf = (cs: CSSStyleDeclaration): string | null => {
		const w = px(cs.borderTopWidth);
		if (
			w <= 0 ||
			cs.borderTopStyle === "none" ||
			cs.borderTopStyle === "hidden"
		)
			return null;
		const c = toHex(cs.borderTopColor);
		return rgba(c)[3] > 0 ? `${r2(w)}px ${cs.borderTopStyle} ${c}` : null;
	};
	const visit = (
		el: Element,
		parent: number,
		opacity: number,
		under: string,
	): void => {
		const cs = getComputedStyle(el);
		if (cs.display === "none") return;
		const alpha = opacity * px(cs.opacity);
		if (alpha <= 0.01) return;
		const own = toHex(cs.backgroundColor);
		const eff = over(own, under);
		const r = el.getBoundingClientRect();
		const shown =
			cs.visibility !== "hidden" &&
			r.width > 0 &&
			r.height > 0 &&
			r.x < crop.x + crop.width &&
			r.y < crop.y + crop.height &&
			r.x + r.width > crop.x &&
			r.y + r.height > crop.y;
		let me = parent;
		if (shown) {
			if (elements.length >= max) {
				truncated = true;
				return;
			}
			const text = ownText(el);
			const radius = cs.borderTopLeftRadius.endsWith("%")
				? (px(cs.borderTopLeftRadius) / 100) * Math.min(r.width, r.height)
				: px(cs.borderTopLeftRadius);
			me = elements.length;
			index.set(el, me);
			const cls = Array.from(el.classList).slice(0, 2).join(".");
			elements.push({
				parent,
				tag: el.tagName.toLowerCase(),
				name: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}`,
				box: { x: r2(r.x), y: r2(r.y), w: r2(r.width), h: r2(r.height) },
				fontFamily: resolveFamily(cs.fontFamily),
				fontSize: r2(px(cs.fontSize)),
				fontWeight: px(cs.fontWeight),
				lineHeight: cs.lineHeight === "normal" ? null : r2(px(cs.lineHeight)),
				letterSpacing:
					cs.letterSpacing === "normal" ? 0 : r2(px(cs.letterSpacing)),
				color: toHex(cs.color),
				background: own,
				effectiveBackground: eff,
				radius: r2(radius),
				border: borderOf(cs),
				boxShadow: cs.boxShadow,
				opacity: r2(alpha),
				text: text.slice(0, 60),
				textLength: text.length,
			});
		}
		for (const child of Array.from(el.children)) visit(child, me, alpha, eff);
	};
	if (root) visit(root, -1, opacity0, background);
	return {
		background:
			root === document.body
				? over(toHex(getComputedStyle(root).backgroundColor), background)
				: background,
		target: target ?? "body",
		elements,
		tracked: Object.fromEntries(
			tracked.map((sel) => [
				sel,
				Array.from(document.querySelectorAll(sel)).map(
					(el) => index.get(el) ?? -1,
				),
			]),
		),
		truncated,
	};
}

/** Computed styles of every visible element under the target (the clip selector, or body). */
export function dumpPageStyles(
	page: Page,
	input: Omit<DumpInput, "max"> & { max?: number },
): Promise<PageStyles> {
	return page.evaluate(dumpInPage, {
		...input,
		max: input.max ?? MAX_LOOK_ELEMENTS,
	});
}
