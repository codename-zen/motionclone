import type { Plane } from "./luma.ts";

// Above this sigma three box passes match the Gaussian variance exactly at a fixed cost per pixel.
const EXACT_UP_TO = 4;

type Line = (
	src: Float32Array,
	dst: Float32Array,
	start: number,
	step: number,
	n: number,
) => void;

function kernelLine(sigma: number): Line {
	const r = Math.ceil(3 * sigma);
	const k = Array.from({ length: 2 * r + 1 }, (_, i) =>
		Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)),
	);
	const total = k.reduce((a, b) => a + b, 0);
	const w = k.map((v) => v / total);
	return (src, dst, start, step, n) => {
		for (let i = 0; i < n; i++) {
			let acc = 0;
			for (let j = -r; j <= r; j++) {
				const at = Math.min(n - 1, Math.max(0, i + j));
				acc += (w[j + r] as number) * (src[start + at * step] as number);
			}
			dst[start + i * step] = acc;
		}
	};
}

function boxLine(r: number): Line {
	const width = 2 * r + 1;
	return (src, dst, start, step, n) => {
		const at = (i: number) =>
			src[start + Math.min(n - 1, Math.max(0, i)) * step] as number;
		let acc = 0;
		for (let j = -r; j <= r; j++) acc += at(j);
		for (let i = 0; i < n; i++) {
			dst[start + i * step] = acc / width;
			acc += at(i + r + 1) - at(i - r);
		}
	};
}

// Widths of three odd boxes whose summed variance equals sigma squared.
function boxRadii(sigma: number): number[] {
	const n = 3;
	let wl = Math.floor(Math.sqrt((12 * sigma * sigma) / n + 1));
	if (wl % 2 === 0) wl--;
	const m = Math.round(
		(12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4),
	);
	return Array.from({ length: n }, (_, i) => ((i < m ? wl : wl + 2) - 1) / 2);
}

function pass(p: Plane, lines: Line[]): Plane {
	const { width: w, height: h } = p;
	let a = Float32Array.from(p.data);
	let b = new Float32Array(a.length);
	for (const line of lines) {
		for (let y = 0; y < h; y++) line(a, b, y * w, 1, w);
		[a, b] = [b, a];
		for (let x = 0; x < w; x++) line(a, b, x, w, h);
		[a, b] = [b, a];
	}
	return { width: w, height: h, data: a };
}

/** Gaussian blur with standard deviation `sigma` pixels; edges repeat the border pixel. */
export function gaussian(p: Plane, sigma: number): Plane {
	if (sigma < 0.05) return p;
	if (sigma <= EXACT_UP_TO) return pass(p, [kernelLine(sigma)]);
	return pass(p, boxRadii(sigma).map(boxLine));
}
