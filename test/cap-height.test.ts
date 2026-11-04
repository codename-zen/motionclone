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
	/** Cap height the browser draws: the ink height of a stem of "H" on this page. */
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

/**
 * Ink height of the "HHH" in a box, CSS px. Each row's ink (darkness summed across) over the ink of a typical row, the
 * stems alone, capped at 1: antialiased top and bottom rows count in part, wherever the stems fall on the pixel grid.
 */
function stemHeight(
	png: PNG,
	b: { x: number; y: number; w: number; h: number },
	scale: number,
): number {
	const x0 = Math.floor(b.x * scale);
	const x1 = Math.ceil((b.x + b.w) * scale);
	const y0 = Math.floor(b.y * scale);
	const y1 = Math.ceil((b.y + b.h) * scale);
	const rows: number[] = [];
	for (let y = y0; y < y1; y++) {
		let ink = 0;
		for (let x = x0; x < x1; x++)
			ink += (255 - (png.data[(y * png.width + x) * 4] as number)) / 255;
		rows.push(ink);
	}
	const inked = rows.filter((v) => v > 0.05).sort((a, c) => a - c);
	const typical = inked[inked.length >> 1] ?? 1;
	return rows.reduce((h, v) => h + Math.min(1, v / typical), 0) / scale;
}

async function ladder(hash: string, deviceScaleFactor: number) {
	const context = await browser.newContext({
		viewport: VIEWPORT,
		deviceScaleFactor,
	});
	const page = await context.newPage();
	await page.goto(PAGE + hash);
	await page.evaluate(() => document.fonts.ready);
	const png = PNG.sync.read(await page.screenshot());
	const lines = pixelLook(png, { x: 0, y: 0, ...VIEWPORT }).lines;
	// The cap height this browser and OS draw: each line set again as "HHH", its stem's ink height in the pixels.
	const want = await page.evaluate(() =>
		[...document.querySelectorAll("p")].map((p) => {
			p.textContent = "HHH";
			const r = p.getBoundingClientRect();
			return {
				size: Number.parseFloat(getComputedStyle(p).fontSize),
				box: { x: r.x, y: r.y, w: r.width, h: r.height },
				baseline: r.bottom,
			};
		}),
	);
	const stems = PNG.sync.read(await page.screenshot());
	await context.close();
	return want.map(
		(w): Rung => ({
			size: w.size,
			want: stemHeight(stems, w.box, deviceScaleFactor),
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
					expect(r.got?.glyphs).toBeGreaterThanOrEqual(1);
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
