import type { ClipRect } from "../capture/options.ts";
import { readPng } from "../verify/pixels.ts";
import { excluded, type FrameRect, type Rect, toFrameRect } from "./region.ts";

export interface RegionFrames {
	/** Null when the region lies outside the frame. */
	rect: FrameRect | null;
	/** Sampled RGB bytes per frame. */
	frames: Uint8Array[];
}

function crop(data: Uint8Array, width: number, r: FrameRect): Uint8Array {
	const cols = Math.ceil((r.x1 - r.x0) / r.step);
	const rows = Math.ceil((r.y1 - r.y0) / r.step);
	const out = new Uint8Array(cols * rows * 3);
	let o = 0;
	for (let y = r.y0; y < r.y1; y += r.step)
		for (let x = r.x0; x < r.x1; x += r.step) {
			if (r.exclude.length > 0 && excluded(r, x, y)) continue;
			const p = (y * width + x) * 4;
			out[o++] = data[p] as number;
			out[o++] = data[p + 1] as number;
			out[o++] = data[p + 2] as number;
		}
	return o === out.length ? out : out.slice(0, o);
}

/** Sampled pixels of each region on every frame of a capture, decoding each frame once. */
export async function readRegions(
	dir: string,
	frameCount: number,
	clip: ClipRect,
	regions: readonly Rect[],
): Promise<RegionFrames[]> {
	const out: RegionFrames[] = regions.map(() => ({ rect: null, frames: [] }));
	for (let k = 0; k < frameCount; k++) {
		const png = await readPng(dir, k);
		regions.forEach((r, i) => {
			const slot = out[i] as RegionFrames;
			if (k === 0) slot.rect = toFrameRect(r, clip, png);
			if (slot.rect) slot.frames.push(crop(png.data, png.width, slot.rect));
		});
	}
	return out;
}
