import type { PNG } from "pngjs";
import { ssim } from "ssim.js";
import type { LookFrame } from "../spec/look-schema.ts";
import { gaussian } from "../video/blur.ts";
import type { Plane } from "../video/luma.ts";
import { readPng } from "./pixels.ts";
import type { StructureFrame, StructureResult } from "./schema.ts";

// Both frames are compared at this width, whatever their pixel sizes.
const WIDTH = 320;

/** Rec. 601 grayscale, area-averaged down to width x height. */
function greyAt(png: PNG, width: number, height: number): Plane {
	const data = new Float32Array(width * height);
	const sx = png.width / width;
	const sy = png.height / height;
	for (let ty = 0; ty < height; ty++) {
		const y0 = Math.floor(ty * sy);
		const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * sy));
		for (let tx = 0; tx < width; tx++) {
			const x0 = Math.floor(tx * sx);
			const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * sx));
			let sum = 0;
			for (let y = y0; y < y1; y++)
				for (let x = x0; x < x1; x++) {
					const p = (y * png.width + x) * 4;
					sum +=
						0.299 * (png.data[p] as number) +
						0.587 * (png.data[p + 1] as number) +
						0.114 * (png.data[p + 2] as number);
				}
			data[ty * width + tx] = sum / ((y1 - y0) * (x1 - x0));
		}
	}
	return { width, height, data };
}

function rgba(p: Plane) {
	const data = new Uint8ClampedArray(p.width * p.height * 4);
	for (let i = 0; i < p.width * p.height; i++) {
		const v = p.data[i] as number;
		data[i * 4] = v;
		data[i * 4 + 1] = v;
		data[i * 4 + 2] = v;
		data[i * 4 + 3] = 255;
	}
	return { data, width: p.width, height: p.height };
}

/** SSIM of two frames as grayscale, blurred by `blurPx` CSS px, at a common size. */
export function blurredSsim(
	a: PNG,
	b: PNG,
	blurPx: number,
	cssWidth: number,
): number {
	const width = Math.min(WIDTH, a.width);
	const height = Math.max(1, Math.round((width * a.height) / a.width));
	const sigma = (blurPx * width) / cssWidth;
	const ga = gaussian(greyAt(a, width, height), sigma);
	const gb = gaussian(greyAt(b, width, height), sigma);
	return ssim(rgba(ga), rgba(gb)).mssim;
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** The structure score on every reference rest frame; the clone frame with the same index is compared. */
export async function structureScore(
	refDir: string,
	cloneDir: string,
	frames: readonly LookFrame[],
	cloneFrames: number,
	cssWidth: number,
	{ blurPx, threshold }: { blurPx: number; threshold: number },
): Promise<StructureResult> {
	const out: StructureFrame[] = [];
	for (const f of frames) {
		const [a, b] = await Promise.all([
			readPng(refDir, f.frame),
			readPng(cloneDir, Math.min(f.frame, cloneFrames - 1)),
		]);
		const score = r4(blurredSsim(a, b, blurPx, cssWidth));
		out.push({ ...f, ssim: score, pass: score >= threshold });
	}
	const minSsim = out.length ? Math.min(...out.map((f) => f.ssim)) : null;
	return {
		blurPx,
		threshold,
		frames: out,
		minSsim,
		pass: out.every((f) => f.pass),
	};
}
