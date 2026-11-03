import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { unitCurve } from "../src/spec/easing.ts";
import type { SpecRow } from "../src/spec/schema.ts";
import type { Verdict } from "../src/verify/schema.ts";

const ROOT = resolve(import.meta.dirname, "..");
export const PAGE = "expand-dim-reveal";
export const FPS = 57;
export const FRAME_MS = 1000 / FPS;
export const VIEWPORT = { width: 816, height: 1080 };
export const HEADER = { x: 0, y: 0, w: 816, h: 300 };
export const REVEAL = { startMs: 1500, durationMs: 260 };
export const DIM = { startMs: 650, durationMs: 272 };

// The reveal 120 ms late, and the dim the way a confidently wrong tracker row described it.
const VARIANTS = {
	late: ["260ms linear 1500ms", "260ms linear 1620ms"],
	dim: [
		"272ms cubic-bezier(0.25, 0.1, 0.25, 1) 650ms",
		"339ms cubic-bezier(0.2, 0, 0, 1) 650ms",
	],
} as const;

/** Start within a frame plus 5 ms, duration within 30 ms. */
export const expectTiming = (
	got: { startMs: number; durationMs: number },
	want: { startMs: number; durationMs: number },
) => {
	expect(Math.abs(got.startMs - want.startMs)).toBeLessThanOrEqual(
		FRAME_MS + 5,
	);
	expect(Math.abs(got.durationMs - want.durationMs)).toBeLessThanOrEqual(30);
};

/** Largest gap between an easing and linear. */
export const linearGap = (e: SpecRow["easing"]) => {
	const curve = unitCurve(e);
	let gap = 0;
	for (let i = 0; i <= 100; i++)
		gap = Math.max(gap, Math.abs(curve(i / 100) - i / 100));
	return gap;
};

/** Rows that fail and count: advisory rows never fail a verdict. */
export const failing = (v: Verdict) =>
	v.rows.filter((r) => !r.pass && r.advisory === null);

/** The fixture with one CSS change, written to `dir`; returns its file URL. */
export async function variantPage(
	dir: string,
	name: keyof typeof VARIANTS,
): Promise<string> {
	const [from, to] = VARIANTS[name];
	const html = await readFile(
		join(ROOT, `fixtures/${PAGE}/index.html`),
		"utf8",
	);
	if (!html.includes(from)) throw new Error(`${PAGE} no longer has ${from}`);
	const page = join(dir, `${name}.html`);
	await writeFile(page, html.replace(from, to));
	return pathToFileURL(page).href;
}
