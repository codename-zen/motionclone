import type { PixelRect } from "./options.ts";

// A css-scale like 2.625 (21/8) needs sizes in steps of 21 video pixels.
const MAX_TRIM = 32;

const whole = (v: number) => Math.abs(v - Math.round(v)) < 1e-6;

/** The largest size at or below `size`, trimming at most MAX_TRIM pixels, that is a whole number of CSS pixels. */
function fitSize(size: number, cssScale: number): number | null {
	for (let s = size; s >= Math.max(1, size - MAX_TRIM); s--)
		if (whole(s / cssScale)) return s;
	return null;
}

const rectText = (r: PixelRect) => `${r.x},${r.y},${r.w},${r.h}`;

/**
 * Trim the right and bottom of a crop so it spans whole CSS pixels at `cssScale`: a clone captured at that
 * device scale factor then has exactly the crop's pixel size. Region coordinates stay valid because x and y keep.
 */
export function fitCropToScale(
	crop: PixelRect,
	cssScale: number,
): { crop: PixelRect; warning?: string } {
	const w = fitSize(crop.w, cssScale);
	const h = fitSize(crop.h, cssScale);
	if (w === null || h === null)
		return {
			crop,
			warning: `crop ${rectText(crop)} is not a whole number of CSS pixels at css-scale ${cssScale} and no crop up to ${MAX_TRIM} px smaller is: clone frames may differ from the reference frames by a pixel`,
		};
	if (w === crop.w && h === crop.h) return { crop };
	const fitted = { ...crop, w, h };
	return {
		crop: fitted,
		warning: `crop ${rectText(crop)} is not a whole number of CSS pixels at css-scale ${cssScale}; trimmed to ${rectText(fitted)} (${Math.round(w / cssScale)}x${Math.round(h / cssScale)} CSS px) so clone frames match the reference frames`,
	};
}
