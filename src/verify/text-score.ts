import type { PNG } from "pngjs";
import type { FracBox, TypeLine } from "../look/schema.ts";
import { inBox } from "../look/type.ts";

/** A reference text band with the cap height of its lines, as a share of the frame height, when it has lines. */
export type TextBand = FracBox & { cap?: number };

// Profiles are smoothed across the line by this share of the band's cap height: weight and the x-height of another
// family of the same size move ink by less than that, a size 25 % off by more.
const SMOOTH_CAPS = 0.075;
// A band without measured lines takes this share of its height as its cap height.
const CAP_OF_BAND = 0.5;

// Each band is read this much taller on both sides, as a share of its height, so a moved or larger line still shows.
const PAD = 0.25;

const grey = (png: PNG, x: number, y: number) => {
	const p = (y * png.width + x) * 4;
	return (
		0.299 * (png.data[p] as number) +
		0.587 * (png.data[p + 1] as number) +
		0.114 * (png.data[p + 2] as number)
	);
};

/** Per row of the band, the mean grey distance from the band's median grey: where its ink sits, not which words. */
function rowProfile(png: PNG, b: FracBox): number[] {
	const pad = PAD * b.h;
	const x0 = Math.max(0, Math.floor(b.x * png.width));
	const x1 = Math.min(png.width, Math.ceil((b.x + b.w) * png.width));
	const y0 = Math.max(0, Math.floor((b.y - pad) * png.height));
	const y1 = Math.min(png.height, Math.ceil((b.y + b.h + pad) * png.height));
	if (x1 <= x0 || y1 <= y0) return [];
	const values: number[] = [];
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) values.push(grey(png, x, y));
	const bg = values.sort((a, b) => a - b)[values.length >> 1] as number;
	const out: number[] = [];
	for (let y = y0; y < y1; y++) {
		let sum = 0;
		for (let x = x0; x < x1; x++) sum += Math.abs(grey(png, x, y) - bg);
		out.push(sum / (x1 - x0));
	}
	return out;
}

// The same rows at another frame size: linear interpolation to n samples.
function resample(v: number[], n: number): number[] {
	if (v.length === n || v.length < 2) return v;
	return Array.from({ length: n }, (_, i) => {
		const x = (i * (v.length - 1)) / Math.max(1, n - 1);
		const k = Math.floor(x);
		const f = x - k;
		return (
			(v[k] as number) * (1 - f) +
			(v[Math.min(k + 1, v.length - 1)] as number) * f
		);
	});
}

/** Gaussian smoothing with sigma in samples. */
function smooth(v: number[], sigma: number): number[] {
	if (sigma <= 0) return v;
	const r = Math.ceil(3 * sigma);
	return v.map((_, i) => {
		let sum = 0;
		let weight = 0;
		for (let k = Math.max(0, i - r); k <= Math.min(v.length - 1, i + r); k++) {
			const w = Math.exp(-((k - i) ** 2) / (2 * sigma * sigma));
			sum += w * (v[k] as number);
			weight += w;
		}
		return sum / weight;
	});
}

/** Each band with the median cap height of the reference lines in it; caps in CSS px over a frame `cssHeight` tall. */
export function withCaps(
	bands: readonly FracBox[],
	lines: readonly TypeLine[],
	cssHeight: number,
): TextBand[] {
	return bands.map((b) => {
		const caps = lines
			.filter((l) => inBox(l, b))
			.map((l) => l.cap)
			.sort((x, y) => x - y);
		const cap = caps[caps.length >> 1];
		return cap === undefined ? b : { ...b, cap: cap / cssHeight };
	});
}

function cosine(a: number[], b: number[]): number {
	let ab = 0;
	let aa = 0;
	let bb = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		ab += (a[i] as number) * (b[i] as number);
		aa += (a[i] as number) ** 2;
		bb += (b[i] as number) ** 2;
	}
	if (aa === 0 && bb === 0) return 1;
	return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * How alike the text lines of two frames sit, 0..1: per reference text band, the cosine of the two frames' row
 * profiles (averaged along the line, smoothed across it by 0.075 of its cap height), weighted by band width. Other
 * words, and another family of the same size, keep the profile; a smaller or moved line changes it. Null without
 * bands.
 */
export function textScore(
	ref: PNG,
	clone: PNG,
	bands: readonly TextBand[],
): number | null {
	let sum = 0;
	let weight = 0;
	for (const b of bands) {
		const cap = SMOOTH_CAPS * (b.cap ?? CAP_OF_BAND * b.h);
		const a = smooth(rowProfile(ref, b), cap * ref.height);
		if (a.length === 0) continue;
		const c = smooth(rowProfile(clone, b), cap * clone.height);
		sum += b.w * cosine(a, resample(c, a.length));
		weight += b.w;
	}
	return weight ? sum / weight : null;
}
