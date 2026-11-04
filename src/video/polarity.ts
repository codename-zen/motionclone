import type { Plane } from "./luma.ts";
import type { Rect } from "./match.ts";
import type { RegionSample } from "./samples.ts";
import type { Pose } from "./search.ts";

/** Luma of what surrounds an element's window, and how far its own pixels swing, at the reference frame. */
export interface Backdrop {
	luma: number;
	swing: number;
}

// The ring of window pixels read as the backdrop, frame pixels.
const RING = 2;
// Swing below this many luma levels is too flat to tell light from dark.
const MIN_SWING = 16;
// Inverted readings are scaled to the strongest one that holds for this many frames.
const PLATEAU_FRAMES = 6;
// A plateau under this contrast is no full appearance to scale to.
const MIN_PLATEAU = 0.5;

function ringMean(p: Plane, r: Rect): number | null {
	const x0 = Math.max(0, Math.round(r.x));
	const y0 = Math.max(0, Math.round(r.y));
	const x1 = Math.min(p.width, Math.round(r.x + r.w));
	const y1 = Math.min(p.height, Math.round(r.y + r.h));
	if (x1 - x0 <= 2 * RING || y1 - y0 <= 2 * RING) return null;
	let sum = 0;
	let n = 0;
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++)
			if (x < x0 + RING || x >= x1 - RING || y < y0 + RING || y >= y1 - RING) {
				sum += p.data[y * p.width + x] as number;
				n++;
			}
	return sum / n;
}

export function backdropOf(p: Plane, win: Rect): Backdrop {
	const values: number[] = [];
	for (let y = win.y; y < win.y + win.h; y++)
		for (let x = win.x; x < win.x + win.w; x++)
			values.push(p.data[y * p.width + x] as number);
	values.sort((a, b) => a - b);
	const at = (q: number) =>
		values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
	return { luma: ringMean(p, win) ?? 0, swing: at(0.97) - at(0.03) };
}

/** The backdrop around the window at a pose moved across half the element's swing: light and dark swapped. */
export function backdropFlipped(
	b: Backdrop,
	p: Plane,
	win: Rect,
	pose: Pose,
): boolean {
	if (b.swing < MIN_SWING) return false;
	const w = win.w * pose.s;
	const h = win.h * pose.s;
	const now = ringMean(p, { x: pose.cx - w / 2, y: pose.cy - h / 2, w, h });
	return now !== null && Math.abs(now - b.luma) >= b.swing / 2;
}

/**
 * Inverted readings measure contrast against the reference appearance, whose ink and backdrop differ in the other
 * state. Scale them to the strongest contrast they hold for a few frames: full opacity on that backdrop.
 */
export function scaleInverted(samples: RegionSample[]): void {
	let full = 0;
	let run: number[] = [];
	for (const s of samples) {
		if (!(s.found && s.inverted)) {
			run = [];
			continue;
		}
		run.push(s.opacity);
		if (run.length > PLATEAU_FRAMES) run.shift();
		if (run.length === PLATEAU_FRAMES) full = Math.max(full, Math.min(...run));
	}
	if (full < MIN_PLATEAU) return;
	for (const s of samples)
		if (s.found && s.inverted) s.opacity = Math.min(1, s.opacity / full);
}
