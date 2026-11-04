import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { deltaE2000, parseHex, rgbToLab } from "../src/look/colour.ts";
import { readLook } from "../src/look/file.ts";
import { pixelLook } from "../src/look/pixels.ts";
import { readTrack } from "../src/measure/elements.ts";

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

// LCD antialiasing tints a glyph's edges: the side where ink rises reddish, the side where it falls bluish.
const FRINGE = 45;

/** Grayscale text with subpixel-like coloured fringes on its antialiased edge pixels, the same on every OS. */
function withFringes(png: PNG): PNG {
	const out = new PNG({ width: png.width, height: png.height });
	png.data.copy(out.data);
	const grey = (i: number) => png.data[i] as number;
	for (let y = 0; y < png.height; y++)
		for (let x = 1; x < png.width - 1; x++) {
			const i = (y * png.width + x) * 4;
			const v = grey(i);
			if (v < 30 || v > 225) continue;
			const side = Math.sign(grey(i - 4) - grey(i + 4)) * FRINGE;
			const clamp = (c: number) => Math.min(255, Math.max(0, c));
			out.data[i] = clamp(v + side);
			out.data[i + 2] = clamp(v - side);
		}
	return out;
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
		const out = join(root, "fringes");
		await captureMotion({
			url: page,
			outDir: out,
			viewport: VIEWPORT,
			durationMs: 100,
			fps: 30,
		});
		const png = withFringes(
			PNG.sync.read(await readFile(join(out, "frames", "0000.png"))),
		);
		expect(chromatic(png)).toBeGreaterThan(500);
		const text = pixelLook(png, { x: 0, y: 0, ...VIEWPORT }).text;
		expect(text).toBeTruthy();
		expect(deltaE(text as string)).toBeLessThan(3);
	});
});

// Bold capitals this large cover more of their line than the gaps between them do (about 56 %).
const bold = (bg: string, ink: string, text: string) =>
	`<!doctype html><html><body style="margin:0;background:${bg}"><div class="t" style="position:absolute;left:24px;top:24px;color:${ink};font:700 48px/1 Arial, sans-serif">${text}</div><p style="position:absolute;left:24px;top:220px;margin:0;color:${ink};font:16px Arial, sans-serif">${"plain words ".repeat(20)}</p></body></html>`;

describe("text colour of large bold glyphs in a tight region", () => {
	const read = async (name: string, bg: string, ink: string, text = "HEM") => {
		const file = join(root, `${name}.html`);
		await writeFile(file, bold(bg, ink, text));
		const out = join(root, name);
		await captureMotion({
			url: file,
			outDir: out,
			viewport: VIEWPORT,
			durationMs: 100,
			fps: 30,
			deviceScaleFactor: 1.5,
			track: [".t"],
		});
		const box = (await readTrack(out)).frames[0]?.elements[".t"]?.[0];
		const png = PNG.sync.read(await readFile(join(out, "frames", "0000.png")));
		const look = pixelLook(png, { x: 0, y: 0, ...VIEWPORT }, [
			{ key: ".t[0]", box: box as NonNullable<typeof box> },
		]);
		return look.regions[0]?.text as string;
	};
	const near = (hex: string, want: string) => deltaE2000(lab(hex), lab(want));

	it("reads the glyph core, on light and on dark", async () => {
		expect(
			near(await read("bold-light", "#fffdff", "#0a080a"), "#0a080a"),
		).toBeLessThan(3);
		expect(
			near(await read("bold-dark", "#131114", "#fdfcfd", "Fri"), "#fdfcfd"),
		).toBeLessThan(3);
	});

	it("still tells grey glyphs from black ones", async () => {
		const grey = await read("bold-grey", "#fffdff", "#8a878a");
		expect(near(grey, "#8a878a")).toBeLessThan(3);
		expect(near(grey, "#0a080a")).toBeGreaterThan(20);
	});
});
