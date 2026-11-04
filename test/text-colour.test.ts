import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { deltaE2000, parseHex, rgbToLab } from "../src/look/colour.ts";
import { readLook } from "../src/look/file.ts";
import { pixelLook } from "../src/look/pixels.ts";

const INK = "#111111";
const PAGE = `<!doctype html><html><body style="margin:0;background:#fff;color:${INK};font:16px/1.4 'Segoe UI', Arial, sans-serif">
<div style="padding:40px;width:560px">${"The quick brown fox jumps over the lazy dog. ".repeat(12)}</div>
</body></html>`;
const VIEWPORT = { width: 640, height: 320 };

const lab = (hex: string) => {
	const c = parseHex(hex);
	return rgbToLab(c.r, c.g, c.b);
};
const deltaE = (hex: string) => deltaE2000(lab(hex), lab(INK));

/** Pixels whose channels differ by more than 20 levels: subpixel text fringes. */
function chromatic(png: PNG): number {
	let n = 0;
	for (let i = 0; i < png.data.length; i += 4) {
		const r = png.data[i] as number;
		const g = png.data[i + 1] as number;
		const b = png.data[i + 2] as number;
		if (Math.max(r, g, b) - Math.min(r, g, b) > 20) n++;
	}
	return n;
}

let root: string;
let page: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-text-colour-"));
	page = join(root, "text.html");
	await writeFile(page, PAGE);
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("text colour from pixels", () => {
	it("captures grayscale text, so near-black text measures near-neutral", async () => {
		const out = join(root, "capture");
		await captureMotion({
			url: page,
			outDir: out,
			viewport: VIEWPORT,
			durationMs: 100,
			fps: 30,
		});
		const frame = PNG.sync.read(
			await readFile(join(out, "frames", "0000.png")),
		);
		expect(chromatic(frame)).toBe(0);
		const text = (await readLook(out))?.states.at(-1)?.pixels.text;
		expect(text).toBeTruthy();
		expect(deltaE(text as string)).toBeLessThan(3);
	});

	it("leaves out coloured subpixel fringes when the ink is near-neutral", async () => {
		// The browser's own default: subpixel (LCD) text on Windows, grayscale elsewhere.
		const browser = await chromium.launch();
		const tab = await browser.newPage({ viewport: VIEWPORT });
		await tab.setContent(PAGE);
		const png = PNG.sync.read(await tab.screenshot());
		await browser.close();
		const text = pixelLook(png, { x: 0, y: 0, ...VIEWPORT }).text;
		expect(text).toBeTruthy();
		expect(deltaE(text as string)).toBeLessThan(3);
	});
});
