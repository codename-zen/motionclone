import type { Page } from "playwright";
import { PNG } from "pngjs";
import type { CaptureOptions, ClipRect } from "../capture/options.ts";
import type { TrackFrame } from "../capture/types.ts";
import { regionsAt, writeLook } from "./file.ts";
import { dumpPageStyles, MAX_LOOK_ELEMENTS } from "./page.ts";
import { pixelLook } from "./pixels.ts";
import { LOOK_VERSION, type LookState, type PageStyles } from "./schema.ts";
import { pageSummary } from "./summary.ts";

interface Dump {
	label: "first" | "last";
	frame: number;
	t: number;
	rest: boolean;
	png: Buffer;
	page: PageStyles;
}

/** Records the page's styles at its first rest frame and at its last frame, then writes look.json. */
export function createLookRecorder(
	page: Page,
	opts: Pick<CaptureOptions, "clip" | "track">,
	crop: ClipRect,
) {
	const target =
		opts.clip && "selector" in opts.clip ? opts.clip.selector : null;
	const dump = () =>
		dumpPageStyles(page, { target, tracked: opts.track, crop });
	const dumps: Dump[] = [];
	let prev: Buffer | null = null;
	let lastRest = false;
	return {
		/** Call after every frame is written, while the page shows that frame. */
		async frame(frame: number, t: number, png: Buffer): Promise<void> {
			lastRest = prev?.equals(png) ?? false;
			prev = png;
			if (lastRest && dumps.length === 0)
				dumps.push({
					label: "first",
					frame,
					t,
					rest: true,
					png,
					page: await dump(),
				});
		},
		/** Call once after the last frame, while the page still shows it. */
		async finish(
			outDir: string,
			frames: TrackFrame[],
			warnings: string[],
		): Promise<void> {
			const end = frames.at(-1) as TrackFrame;
			if (dumps.at(-1)?.frame === end.frame)
				(dumps.at(-1) as Dump).label = "last";
			else
				dumps.push({
					label: "last",
					frame: end.frame,
					t: end.t,
					rest: lastRest,
					png: prev as Buffer,
					page: await dump(),
				});
			const own: string[] = [];
			if (dumps.some((d) => d.page.truncated))
				own.push(
					`look: only the first ${MAX_LOOK_ELEMENTS} visible elements were recorded`,
				);
			if (!lastRest)
				own.push(
					"look: the page still changes on its last frame; its look is measured mid-motion",
				);
			warnings.push(...own);
			const states: LookState[] = dumps.map((d) => ({
				label: d.label,
				frame: d.frame,
				t: d.t,
				rest: d.rest,
				page: d.page,
				pixels: pixelLook(
					PNG.sync.read(d.png),
					crop,
					regionsAt(frames[d.frame]),
				),
			}));
			const screen = { x: crop.x, y: crop.y, w: crop.width, h: crop.height };
			await writeLook(outDir, {
				version: LOOK_VERSION,
				source: "page",
				screen: { width: crop.width, height: crop.height },
				states,
				summary: pageSummary((dumps.at(-1) as Dump).page, screen),
				warnings: own,
			});
		},
	};
}
