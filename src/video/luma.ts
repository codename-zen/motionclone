import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";

/** A single-channel float image. */
export interface Plane {
	width: number;
	height: number;
	data: Float32Array;
}

export const framePng = (dir: string, k: number) =>
	join(dir, "frames", `${String(k).padStart(4, "0")}.png`);

// 3x3 box blur: compression noise and gif dithering are mostly single-pixel.
function blur3(p: Plane): Plane {
	const { width: w, height: h, data } = p;
	const tmp = new Float32Array(w * h);
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const l = data[x > 0 ? i - 1 : i] as number;
			const r = data[x < w - 1 ? i + 1 : i] as number;
			tmp[i] = (l + (data[i] as number) + r) / 3;
		}
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const u = tmp[y > 0 ? i - w : i] as number;
			const d = tmp[y < h - 1 ? i + w : i] as number;
			out[i] = (u + (tmp[i] as number) + d) / 3;
		}
	return { width: w, height: h, data: out };
}

/** Rec. 601 luma of an RGBA PNG, lightly blurred. */
export function lumaOf(png: PNG): Plane {
	const n = png.width * png.height;
	const data = new Float32Array(n);
	const px = png.data;
	for (let i = 0; i < n; i++)
		data[i] =
			0.299 * (px[4 * i] as number) +
			0.587 * (px[4 * i + 1] as number) +
			0.114 * (px[4 * i + 2] as number);
	return blur3({ width: png.width, height: png.height, data });
}

/** 8-bit RGBA pixels of a frame. */
export interface Rgba {
	width: number;
	height: number;
	data: Uint8Array;
}

export async function readFrame(
	dir: string,
	k: number,
): Promise<{ luma: Plane; rgba: Rgba }> {
	const png = PNG.sync.read(await readFile(framePng(dir, k)));
	return {
		luma: lumaOf(png),
		rgba: { width: png.width, height: png.height, data: png.data },
	};
}

export async function readLuma(dir: string, k: number): Promise<Plane> {
	return (await readFrame(dir, k)).luma;
}

/** Mean of each f x f block; partial blocks at the edges are dropped. */
export function downsample(p: Plane, f: number): Plane {
	const w = Math.floor(p.width / f);
	const h = Math.floor(p.height / f);
	const data = new Float32Array(w * h);
	for (let y = 0; y < h * f; y++)
		for (let x = 0; x < w * f; x++) {
			const o = Math.floor(y / f) * w + Math.floor(x / f);
			data[o] = (data[o] as number) + (p.data[y * p.width + x] as number);
		}
	for (let i = 0; i < data.length; i++) data[i] = (data[i] as number) / (f * f);
	return { width: w, height: h, data };
}
