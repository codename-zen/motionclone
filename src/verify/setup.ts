import { isDeepStrictEqual } from "node:util";
import type { CaptureFile } from "../spec/capture-file.ts";
import type { SpecMeta } from "../spec/schema.ts";
import { cloneSelectorsFor, type MapEntry } from "./map.ts";

interface Settings {
	viewport: { width: number; height: number };
	fps: number;
	trigger: unknown;
	durationMs: number;
	seed: number;
}

const settingsOf = (c: CaptureFile): Settings => ({
	viewport: c.options.viewport,
	fps: c.options.fps,
	trigger: c.options.trigger,
	durationMs: c.options.durationMs,
	seed: c.options.seed,
});

/** True for captures made by captureVideo from a recording or gif. */
export const isVideoCapture = (c: CaptureFile): boolean =>
	(c as { source?: string }).source === "video";

const show = (v: unknown) =>
	typeof v === "object" && v !== null && "width" in v && "height" in v
		? `${v.width}x${v.height}`
		: JSON.stringify(v);

function compare(
	want: Settings,
	got: Settings,
	wantName: string,
	keys: (keyof Settings)[],
	errors: string[],
): void {
	for (const key of keys)
		if (!isDeepStrictEqual(want[key], got[key]))
			errors.push(
				`${key} differs: ${wantName} ${show(want[key])}, clone ${show(got[key])}; capture the clone with ${key} ${show(want[key])}`,
			);
}

const ALL_KEYS: (keyof Settings)[] = [
	"viewport",
	"fps",
	"trigger",
	"durationMs",
	"seed",
];

/** Settings that must match before rows can be compared; empty when the captures are comparable. */
export function setupErrors(
	meta: SpecMeta,
	ref: CaptureFile,
	clone: CaptureFile,
	map: MapEntry[] = [],
): string[] {
	const errors: string[] = [];
	// A recording has no page viewport, trigger or seed: only the frame rate must line up.
	const video = isVideoCapture(ref);
	const keys = video ? (["fps"] as (keyof Settings)[]) : ALL_KEYS;
	compare(settingsOf(ref), settingsOf(clone), "reference", keys, errors);
	if (errors.length === 0)
		compare(
			{
				viewport: meta.viewport,
				fps: meta.fps,
				trigger: meta.trigger,
				durationMs: meta.durationMs,
				seed: meta.seed,
			},
			settingsOf(clone),
			"spec",
			keys,
			errors,
		);
	const missing = meta.track.flatMap((s) =>
		cloneSelectorsFor(map, s).filter((c) => !clone.options.track.includes(c)),
	);
	if (missing.length > 0)
		errors.push(
			video
				? `the clone capture does not track ${missing.join(", ")}; capture it with --track and pass --map <regionName>=<selector>`
				: `the clone capture does not track ${missing.join(", ")}; capture it with the spec's track selectors`,
		);
	return errors;
}
