import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { pixelLook } from "../src/look/pixels.ts";
import { textScore, withCaps } from "../src/verify/text-score.ts";

const W = 480;
const H = 240;
const CLIP = { x: 0, y: 0, width: W, height: H };

function blank(): PNG {
	const png = new PNG({ width: W, height: H });
	png.data.fill(255);
	return png;
}

function fill(png: PNG, x: number, y: number, w: number, h: number) {
	for (let j = Math.round(y); j < Math.round(y + h); j++)
		for (let i = Math.round(x); i < Math.round(x + w); i++) {
			const p = (j * W + i) * 4;
			png.data[p] = 20;
			png.data[p + 1] = 20;
			png.data[p + 2] = 24;
		}
}

/** A letter on `base`: a stem (l, d) or a bowl with a hole (o, e), `h` tall with strokes `s` wide. */
function letter(
	png: PNG,
	x: number,
	base: number,
	h: number,
	kind: "stem" | "bowl",
	s = 3,
) {
	if (kind === "stem") return fill(png, x, base - h, s, h);
	const w = Math.round(0.8 * h);
	fill(png, x, base - h, w, s);
	fill(png, x, base - s, w, s);
	fill(png, x, base - h, s, h);
	fill(png, x + w - s, base - h, s, h);
}

/** Words of capitals and lowercase letters; `x` is the lowercase height. */
function words(
	png: PNG,
	x0: number,
	base: number,
	cap: number,
	x: number,
	s = 3,
) {
	let at = x0;
	for (const [k, kind] of [
		"stem",
		"bowl",
		"bowl",
		"stem",
		"bowl",
		"stem",
		"bowl",
	].entries()) {
		const h = kind === "stem" ? cap : x;
		letter(png, at, base, h, kind as "stem" | "bowl", s);
		at +=
			(kind === "stem" ? s : Math.round(0.8 * h)) +
			Math.round(0.25 * cap) +
			(k === 3 ? Math.round(0.5 * cap) : 0);
	}
}

const dot = (png: PNG, x: number, y: number) => fill(png, x, y, 3, 3);

/** A sun icon: a ring of small dots around a solid core. */
function dottedSun(png: PNG, cx: number, cy: number) {
	for (let k = 0; k < 12; k++) {
		const a = (k * Math.PI) / 6;
		dot(png, cx + 14 * Math.cos(a) - 1, cy + 14 * Math.sin(a) - 1);
	}
	fill(png, cx - 7, cy - 7, 14, 14);
}

describe("text lines from letters", () => {
	it("measures a line from its letters, not the icon or dots beside it", () => {
		const png = blank();
		// A ring icon taller than any letter, standing on the baseline.
		letter(png, 20, 70, 40, "bowl");
		dot(png, 64, 67);
		dot(png, 72, 67);
		words(png, 90, 70, 24, 17);
		const lines = pixelLook(png, CLIP).lines;
		expect(lines).toHaveLength(1);
		expect(lines[0]?.cap).toBeCloseTo(24, 0);
		expect(lines[0]?.x).toBeGreaterThan(80 / W);
	});

	it("reads no line from a ring of dots or a struck-through word", () => {
		const png = blank();
		dottedSun(png, 40, 60);
		words(png, 90, 70, 24, 17);
		fill(png, 90, 58, 150, 2);
		dottedSun(png, 40, 160);
		expect(pixelLook(png, CLIP).lines).toEqual([]);
	});
});

/** A list of lines: cap height `cap`, lowercase `x`, strokes `s`; line spacing and margin scale with `cap`, as CSS lays them out. */
function list(cap: number, x: number, s: number, shift = 0): PNG {
	const png = blank();
	for (let k = 0; k < 4; k++)
		words(png, 30, shift + 2.5 * cap + 2.25 * cap * k, cap, x, s);
	return png;
}

describe("the text score", () => {
	const ref = list(20, 14, 3);
	const look = pixelLook(ref, CLIP);
	const bands = withCaps(
		look.bands.filter((b) => b.hex !== null),
		look.lines,
		H,
	);
	const score = (clone: PNG) => textScore(ref, clone, bands) as number;

	it("passes another family of the same size: other x-height and weight", () => {
		expect(bands.every((b) => (b.cap ?? 0) > 0)).toBe(true);
		expect(score(list(20, 15, 4))).toBeGreaterThan(0.9);
		expect(score(list(20, 14, 3, 1))).toBeGreaterThan(0.9);
	});

	it("fails text 25 % smaller", () => {
		expect(score(list(15, 10.5, 2))).toBeLessThan(0.75);
	});
});
