import type { Plane } from "./luma.ts";
import type { Rect } from "./match.ts";
import type { Fit } from "./search.ts";

/** found: position, scale and blur measured; faint: position only; absent: nothing above noise; other: something that is not the element. */
export type Status = "found" | "faint" | "absent" | "other";

// Below either value the element is treated as not visible in that frame.
export const MIN_NCC = 0.5;
export const MIN_CONTRAST = 0.05;
// Visible elements read at most 1.03 on h264 crf 18; more means the frame holds more structure than the element.
export const MAX_CONTRAST = 1.25;
// A faint element still gives its position, but not its scale and blur.
export const MIN_SHAPE_CONTRAST = 0.2;
// Real matches explain at least 0.95 of the structure above noise, other content at most 0.88 (notch-expand fixture).
const MIN_FIDELITY = 0.9;
// Scale and blur need the model to stand above the noise; under it the noise alone could produce the fit.
const MIN_SHAPE_SNR = 1;
// A patch this many noise deviations from flat is clearly not empty.
const MIN_BUSY = 3;
// Model amplitude, in noise deviations, from which a reading counts as fully clear.
const CLEAR_SNR = 4;
// Lossless frames show no noise at all; 8-bit rounding after the 3x3 blur leaves about this much.
const MIN_NOISE = 0.25;

/**
 * Luma noise (standard deviation) inside a window: the quietest pair of consecutive frames at one end of the clip,
 * and at least a third of the noise floor, which bounds a single pixel's change.
 */
export function measureNoise(
	planes: Plane[],
	win: Rect,
	floor: number,
): number {
	let quietest = Number.POSITIVE_INFINITY;
	for (let i = 1; i < planes.length; i++) {
		const a = planes[i - 1] as Plane;
		const b = planes[i] as Plane;
		let ss = 0;
		for (let y = win.y; y < win.y + win.h; y++)
			for (let x = win.x; x < win.x + win.w; x++) {
				const o = y * a.width + x;
				ss += ((a.data[o] as number) - (b.data[o] as number)) ** 2;
			}
		quietest = Math.min(quietest, Math.sqrt(ss / (win.w * win.h) / 2));
	}
	return Math.max(
		MIN_NOISE,
		floor / 3,
		Number.isFinite(quietest) ? quietest : 0,
	);
}

export interface Judgement {
	status: Status;
	/** Fidelity times clarity, 0..1. */
	quality: number;
}

/** How well a fit explains the patch, against the noise. */
export function judge(fit: Fit, noise: number): Judgement {
	const explained = Math.max(0, fit.ncc) * fit.spread;
	const unexplained = Math.max(
		0,
		fit.spread ** 2 - explained ** 2 - noise ** 2,
	);
	// Share of the patch's structure above noise that the model explains.
	const fidelity =
		explained > 0 ? explained ** 2 / (explained ** 2 + unexplained) : 0;
	const snr = explained / noise;
	const quality = fidelity * Math.min(1, snr / CLEAR_SNR);
	const plausible = fit.contrast <= MAX_CONTRAST && fidelity >= MIN_FIDELITY;
	const visible = fit.ncc >= MIN_NCC && fit.contrast >= MIN_CONTRAST;
	let status: Status;
	if (visible && plausible)
		status =
			fit.contrast >= MIN_SHAPE_CONTRAST && snr >= MIN_SHAPE_SNR
				? "found"
				: "faint";
	else
		status = !plausible && fit.spread >= MIN_BUSY * noise ? "other" : "absent";
	return { status, quality };
}
