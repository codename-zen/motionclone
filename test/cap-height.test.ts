import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, chromium } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAUNCH_ARGS } from "../src/capture/browser.ts";
import { capHeight, X_PER_CAP } from "../src/look/cap-height.ts";
import { pixelLook } from "../src/look/pixels.ts";
import type { TypeLine } from "../src/look/schema.ts";

const VIEWPORT = { width: 1280, height: 900 };
const PAGE = pathToFileURL(
	join(import.meta.dirname, "../fixtures/type-ladder/index.html"),
).href;

interface Rung {
	size: number;
	/** Cap height the browser draws: the ink ascent of "H", at the device pixel size. */
	want: number;
	got: TypeLine | undefined;
}

let browser: Browser;

beforeAll(async () => {
	browser = await chromium.launch({ args: LAUNCH_ARGS });
}, 60_000);

afterAll(async () => {
	await browser?.close();
});

async function ladder(hash: string, deviceScaleFactor: number) {
	const context = await browser.newContext({
		viewport: VIEWPORT,
		deviceScaleFactor,
	});
	const page = await context.newPage();
	await page.goto(PAGE + hash);
	await page.evaluate(() => document.fonts.ready);
	const want = await page.evaluate(() =>
		[...document.querySelectorAll("p")].map((p) => {
			const s = getComputedStyle(p);
			const size = Number.parseFloat(s.fontSize);
			const c = document.createElement("canvas").getContext("2d");
			if (!c) throw new Error("no canvas");
			c.font = `${s.fontWeight} ${size * devicePixelRatio}px ${s.fontFamily}`;
			return {
				size,
				cap: c.measureText("H").actualBoundingBoxAscent / devicePixelRatio,
				baseline: p.getBoundingClientRect().bottom,
			};
		}),
	);
	const png = PNG.sync.read(await page.screenshot());
	await context.close();
	const lines = pixelLook(png, { x: 0, y: 0, ...VIEWPORT }).lines;
	return want.map(
		(w): Rung => ({
			size: w.size,
			want: w.cap,
			// The baseline lies a quarter em over the line box's bottom, give or take.
			got: lines.find(
				(l) =>
					Math.abs(l.y * VIEWPORT.height - (w.baseline - w.size / 4)) <
					w.size / 2,
			),
		}),
	);
}

describe("cap height across font sizes", () => {
	for (const [name, hash] of [
		["Segoe UI or system-ui", ""],
		["a serif", "#serif"],
	])
		for (const dpr of [1, 1.5])
			it(`follows the font size from 14 to 24 px in ${name} at ${dpr}x`, async () => {
				const rungs = await ladder(hash as string, dpr);
				console.log(
					`${name} ${dpr}x:`,
					rungs
						.map((r) => `${r.size}:${r.want.toFixed(1)}/${r.got?.cap}`)
						.join(" "),
				);
				expect(rungs).toHaveLength(21);
				let prev = 0;
				for (const r of rungs) {
					expect(r.got?.basis).toBe("capitals");
					expect(r.got?.glyphs).toBeGreaterThanOrEqual(2);
					const cap = r.got?.cap ?? 0;
					expect(Math.abs(cap - r.want)).toBeLessThanOrEqual(0.6);
					// Reported caps are rounded to 0.1 px.
					expect(cap).toBeGreaterThanOrEqual(prev - 0.1);
					prev = cap;
				}
			});
});

describe("cap height of one line", () => {
	const letter = (height: number, topWidth = 1, aspect = 0.7) => ({
		height,
		topWidth,
		aspect,
	});

	it("takes the capitals, not the t or the taller ascenders", () => {
		const line = [
			...[10, 10, 10.1, 9.9, 10, 10].map((h) => letter(h)),
			letter(13, 0.3, 0.4),
			letter(14, 1),
			letter(14, 0.9),
			letter(15, 0.25, 0.6),
			letter(15, 0.2, 0.6),
			letter(15, 1, 0.12),
		];
		expect(capHeight(line, [])).toEqual({
			cap: 14,
			basis: "capitals",
			glyphs: 2,
			x: 10,
		});
	});

	it("reads ascenders, or scales the x-height, of a line without capitals", () => {
		const line = [10, 10, 10, 10, 10.1].map((h) => letter(h));
		const ascenders = [letter(15, 0.25, 0.6), letter(15, 0.2, 0.6)];
		expect(capHeight([...line, ...ascenders], [])).toEqual({
			cap: 15,
			basis: "ascenders",
			glyphs: 2,
			x: 10,
		});
		expect(capHeight(line, [10.1])?.basis).toBe("x-height");
		expect(capHeight(line, [10.1])?.cap).toBeCloseTo(10 / X_PER_CAP);
		expect(capHeight(line, [])).toEqual({
			cap: 10,
			basis: "capitals",
			glyphs: 5,
			x: 10,
		});
	});
});
