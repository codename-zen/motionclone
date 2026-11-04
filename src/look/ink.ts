import type { PNG } from "pngjs";
import { deltaE2000, type Lab, labToHex, rgbToLab } from "./colour.ts";
import { uniformColours } from "./palette.ts";

// Ink is at least this far from the band's background (Lab units).
const INK = 20;
const MAX_PIXELS = 4000;
const SAME_INK_DE = 6;
// Ring pixels this close (Lab units) to a candidate background show that colour around the band.
const SAME_SURFACE = 10;
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

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Lab of the pixels in a thin ring just outside a rectangle, clipped to the frame. */
function ringAround(png: PNG, r: Rect): Float32Array {
	const g = Math.max(2, Math.round((r.y1 - r.y0) / 6));
	const x0 = Math.max(0, r.x0 - g);
	const x1 = Math.min(png.width, r.x1 + g);
	const strips: Rect[] = [
		{ x0, x1, y0: Math.max(0, r.y0 - g), y1: Math.max(0, r.y0) },
		{
			x0,
			x1,
			y0: Math.min(png.height, r.y1),
			y1: Math.min(png.height, r.y1 + g),
		},
		{ x0, x1: Math.max(0, r.x0), y0: r.y0, y1: r.y1 },
		{ x0: Math.min(png.width, r.x1), x1, y0: r.y0, y1: r.y1 },
	];
	const parts = strips
		.filter((s) => s.x1 > s.x0 && s.y1 > s.y0)
		.map((s) => pixelsIn(png, s.x0, s.y0, s.x1, s.y1));
	const out = new Float32Array(parts.reduce((n, q) => n + q.length, 0));
	let o = 0;
	for (const q of parts) {
		out.set(q, o);
		o += q.length;
	}
	return out;
}

/**
 * The band's background: its most common flat colour, unless large bold glyphs cover more of the band than the
 * space between them does; then of its two most common colours the one that also surrounds the band.
 */
function backdropOf(png: PNG, r: Rect, p: Float32Array): Lab | undefined {
	const [first, second] = uniformColours(p, { max: 2, minShare: 0 });
	if (!first || !second) return first?.lab;
	const ring = ringAround(png, r);
	const near = (c: Lab) => {
		let n = 0;
		for (let i = 0; i < ring.length / 3; i++)
			if (
				Math.hypot(
					(ring[i * 3] as number) - c.l,
					(ring[i * 3 + 1] as number) - c.a,
					(ring[i * 3 + 2] as number) - c.b,
				) <= SAME_SURFACE
			)
				n++;
		return n;
	};
	return near(second.lab) > near(first.lab) ? second.lab : first.lab;
}

/** The ink colour of a text band: the quarter of its ink pixels farthest from the band's background, page colour left out. */
export function inkOf(png: PNG, r: Rect, page: Lab | null) {
	const p = pixelsIn(png, r.x0, r.y0, r.x1, r.y1);
	const bg = backdropOf(png, r, p);
	if (!bg) return null;
	const around = page ?? bg;
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
		if (d > INK && dist(i, around) > INK) far.push({ d, i });
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
	// Large bands are sampled sparsely: weigh the ink by the frame pixels it covers, not by its samples.
	const area = (r.x1 - r.x0) * (r.y1 - r.y0);
	return {
		lab: { l: m.l / top.length, a: m.a / top.length, b: m.b / top.length },
		weight: Math.round((far.length / (p.length / 3)) * area),
	};
}

/** The ink colour with the most pixels over all bands, similar inks pooled, and its share of all ink pixels. */
export function inkSummary(
	inks: { lab: Lab; weight: number }[],
): { hex: string; share: number } | null {
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
	const total = groups.reduce((s, g) => s + g.weight, 0);
	return best
		? {
				hex: labToHex(best.lab),
				share: Math.round((best.weight / total) * 1000) / 1000,
			}
		: null;
}

/** The ink colour with the most pixels over all bands, similar inks pooled. */
export const mainInk = (inks: { lab: Lab; weight: number }[]): string | null =>
	inkSummary(inks)?.hex ?? null;
