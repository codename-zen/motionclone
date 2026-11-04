import { measureActivity } from "./activity.ts";
import { fitCropToScale } from "./crop-fit.ts";
import { type CssScaleGuess, guessCssScale } from "./css-scale.ts";
import { type MotionWindow, motionWindows } from "./motion-windows.ts";
import type { PixelRect } from "./options.ts";
import type { VideoProbe } from "./probe.ts";
import { findScreen, type Screen } from "./screen.ts";

export interface ScreenProbe {
	/** Null when nothing moves. */
	screen: Screen | null;
	/** Present when the screen is confident and a phone width fits. */
	scale: CssScaleGuess | null;
	/** The screen trimmed to whole CSS pixels at the suggested scale. */
	crop: PixelRect | null;
	/** Motion inside the screen, or the whole frame without one. */
	windows: MotionWindow[];
}

const SHOWN_WINDOWS = 12;
// Windows whose biggest frame change is below this share of the biggest window's are small changes, not motions.
const MINOR = 0.05;

export async function probeScreen(
	path: string,
	probe: VideoProbe,
): Promise<ScreenProbe> {
	const activity = await measureActivity(path, probe);
	const screen = findScreen(activity);
	const full = { x: 0, y: 0, w: probe.width, h: probe.height };
	const area = screen?.confident ? screen.rect : full;
	const scale = screen?.confident ? guessCssScale(screen.rect.w) : null;
	const crop = screen?.confident
		? fitCropToScale(screen.rect, scale?.cssScale ?? 1).crop
		: null;
	return { screen, scale, crop, windows: motionWindows(activity, area) };
}

const rect = (r: PixelRect) => `${r.w}x${r.h} at ${r.x},${r.y}`;
const s2 = (v: number) => v.toFixed(2);

function screenLine(s: Screen, frame: PixelRect): string {
	const open = (["left", "right", "top", "bottom"] as const).filter(
		(side) => !s.edges.includes(side),
	);
	const touching = open.length
		? `; ${open.join(", ")} ${open.length === 1 ? "runs" : "run"} to the frame edge`
		: "";
	const whole = s.rect.w === frame.w && s.rect.h === frame.h;
	return whole
		? "screen: no bezel or background edge around the motion; the recording looks like the screen itself"
		: `screen: ${rect(s.rect)} (edges on ${s.edges.join(", ") || "no side"}${touching})`;
}

function doubt(s: Screen): string {
	if (s.motionInside < 0.9)
		return `only ${Math.round(s.motionInside * 100)}% of the motion lies inside`;
	if (s.edges.length < 2) return "fewer than two screen edges found";
	return "the edges differ in colour or do not face each other";
}

/** Probe lines about the screen and the motion; `force` also prints an unsure or missing screen. */
export function screenLines(
	p: ScreenProbe,
	frame: { width: number; height: number },
	force: boolean,
): string[] {
	const lines: string[] = [];
	const full = { x: 0, y: 0, w: frame.width, h: frame.height };
	const s = p.screen;
	if (!s) lines.push("motion: none (no frame changes)");
	else if (s.confident) {
		lines.push(screenLine(s, full));
		const c = p.crop as PixelRect;
		const flags = [`--crop ${c.x},${c.y},${c.w},${c.h}`];
		if (p.scale) {
			const cs = p.scale.cssScale;
			flags.push(`--css-scale ${cs}`);
			lines.push(
				`suggested: ${flags.join(" ")} (${Math.round(c.w / cs)}x${Math.round(c.h / cs)} CSS px; closest common phone width ${p.scale.nearest})`,
			);
		} else
			lines.push(
				`suggested: ${flags.join(" ")} (no common phone width fits; set --css-scale yourself)`,
			);
	} else if (force)
		lines.push(
			`${screenLine(s, full)}, not sure: ${doubt(s)}; the motion spans ${rect(s.motion)}`,
		);
	if (s && p.windows.length) {
		const top = Math.max(...p.windows.map((w) => w.peak));
		const main = p.windows.filter((w) => w.peak >= MINOR * top);
		const minor = p.windows.length - main.length;
		const shown = main
			.slice(0, SHOWN_WINDOWS)
			.map((w) => `${s2(w.from)}-${s2(w.to)} s`);
		const more = main.length - shown.length;
		lines.push(
			`motion${s.confident ? " on the screen" : ""}: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""} (use as --start/--end)${minor ? `; ${minor} small change${minor === 1 ? "" : "s"} left out` : ""}`,
		);
	}
	return lines;
}
