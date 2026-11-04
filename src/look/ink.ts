import type { PNG } from "pngjs";
import { deltaE2000, type Lab, labToHex, rgbToLab } from "./colour.ts";
import { uniformColours } from "./palette.ts";

// Ink is at least this far from the band's background (Lab units).
const INK = 20;
const MAX_PIXELS = 4000;
const SAME_INK_DE = 6;
// Subpixel (LCD) antialiasing draws neutral text with fringes of opposite hues that cancel out on average:
// when the mean hue of the ink is under this share of its mean chroma, pixels above STRONG_CHROMA are fringes.
const CANCELLED = 0.5;
const STRONG_CHROMA = 20;

type Far = { d: number; i: number }[];

const chromaAt = (p: Float32Array, i: number) =>
	Math.hypot(p[i * 3 + 1] as number, p[i * 3 + 2] as number);

/** The ink pixels without coloured fringes when the ink itself is near-neutral; all of them otherwise. */
function withoutFringes(p: Float32Array, far: Far): Far {
	let a = 0;
	let b = 0;
	let chroma = 0;
	for (const { i } of far) {
		a += p[i * 3 + 1] as number;
		b += p[i * 3 + 2] as number;
		chroma += chromaAt(p, i);
	}
	if (chroma / far.length <= STRONG_CHROMA / 2) return far;
	if (Math.hypot(a, b) > CANCELLED * chroma) return far;
	const plain = far.filter(({ i }) => chromaAt(p, i) <= STRONG_CHROMA);
	return plain.length >= 8 ? plain : far;
}

/** Lab of the frame pixels in a rectangle, sampled to at most MAX_PIXELS. */
function pixelsIn(
	png: PNG,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): Float32Array {
	const step = Math.max(
		1,
		Math.ceil(Math.sqrt(((x1 - x0) * (y1 - y0)) / MAX_PIXELS)),
	);
	const out: number[] = [];
	for (let y = y0; y < y1; y += step)
		for (let x = x0; x < x1; x += step) {
			const p = (y * png.width + x) * 4;
			const c = rgbToLab(
				png.data[p] as number,
				png.data[p + 1] as number,
				png.data[p + 2] as number,
			);
			out.push(c.l, c.a, c.b);
		}
	return Float32Array.from(out);
}

/** The ink colour of a text band: the quarter of its ink pixels farthest from the band's background, page colour left out. */
export function inkOf(
	png: PNG,
	r: { x0: number; y0: number; x1: number; y1: number },
	page: Lab,
) {
	const p = pixelsIn(png, r.x0, r.y0, r.x1, r.y1);
	const bg = uniformColours(p, { max: 1, minShare: 0 })[0]?.lab;
	if (!bg) return null;
	const dist = (i: number, c: Lab) =>
		Math.hypot(
			(p[i * 3] as number) - c.l,
			(p[i * 3 + 1] as number) - c.a,
			(p[i * 3 + 2] as number) - c.b,
		);
	const far: Far = [];
	// In a band across a surface's edge, the page showing around the surface is not ink.
	for (let i = 0; i < p.length / 3; i++) {
		const d = dist(i, bg);
		if (d > INK && dist(i, page) > INK) far.push({ d, i });
	}
	if (far.length < 8) return null;
	const ink = withoutFringes(p, far).sort((a, b) => b.d - a.d);
	const top = ink.slice(0, Math.max(4, Math.ceil(ink.length / 4)));
	const m = { l: 0, a: 0, b: 0 };
	for (const { i } of top) {
		m.l += p[i * 3] as number;
		m.a += p[i * 3 + 1] as number;
		m.b += p[i * 3 + 2] as number;
	}
	return {
		lab: { l: m.l / top.length, a: m.a / top.length, b: m.b / top.length },
		weight: far.length,
	};
}

/** The ink colour with the most pixels over all bands, similar inks pooled. */
export function mainInk(inks: { lab: Lab; weight: number }[]): string | null {
	const groups: { lab: Lab; weight: number }[] = [];
	for (const ink of [...inks].sort((a, b) => b.weight - a.weight)) {
		const g = groups.find((x) => deltaE2000(x.lab, ink.lab) < SAME_INK_DE);
		if (!g) {
			groups.push({ ...ink, lab: { ...ink.lab } });
			continue;
		}
		const w = g.weight + ink.weight;
		g.lab = {
			l: (g.lab.l * g.weight + ink.lab.l * ink.weight) / w,
			a: (g.lab.a * g.weight + ink.lab.a * ink.weight) / w,
			b: (g.lab.b * g.weight + ink.lab.b * ink.weight) / w,
		};
		g.weight = w;
	}
	const best = groups.sort((a, b) => b.weight - a.weight)[0];
	return best ? labToHex(best.lab) : null;
}
