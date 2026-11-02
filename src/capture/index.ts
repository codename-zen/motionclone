import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { openSession } from "./browser.ts";
import { startCdpRecorder } from "./cdp-animations.ts";
import { createVirtualClock, installClock } from "./clock.ts";
import { createCropWatcher, resolveCrop, writeFrame } from "./frames.ts";
import { mergeAnimations } from "./merge-animations.ts";
import {
	type CaptureInput,
	CaptureOptions,
	DEFAULT_PRE_ROLL_MS,
	DEFAULT_WAIT_BEFORE_MS,
} from "./options.ts";
import { installRafFlush } from "./page-raf.ts";
import { installPageRuntime, type PageRuntime } from "./page-runtime.ts";
import { preSettleMs, runPreActions } from "./pre-actions.ts";
import { detectStack } from "./stack.ts";
import { MAX_MATCHES_PER_SELECTOR, sampleTrack } from "./tracker.ts";
import { planTrigger, prepareTrigger, type TriggerAction } from "./triggers.ts";
import type { CaptureSummary, TrackFrame } from "./types.ts";
import { toUrl } from "./url.ts";

export { type CaptureInput, CaptureOptions } from "./options.ts";
export type * from "./types.ts";
export { toUrl } from "./url.ts";

export const MAX_FRAMES = 3000;
// Virtual ms from the load event to the first rendering frame (one 60 Hz frame, the fake clock's rAF grid).
// A real browser never paints at the load instant: rAF callbacks and pending animations resolve first.
export const FIRST_FRAME_MS = 16;

const json = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;

interface Timeline {
	frameMs: number;
	preFrames: number;
	frames: number;
	waitBeforeMs: number;
	triggerAtMs: number;
	/** Trigger-relative ms of frame k, k counted from the trigger frame; whole ms keep timers exact. */
	timeAt(k: number): number;
}

function planTimeline(opts: CaptureOptions, warnings: string[]): Timeline {
	const isLoad = opts.trigger.type === "load";
	if (isLoad && opts.preRollMs)
		warnings.push(
			"preRollMs ignored for the load trigger: nothing exists before load",
		);
	if (isLoad && opts.waitBeforeMs)
		warnings.push(
			"waitBeforeMs ignored for the load trigger: t=0 is the first frame after load",
		);
	const preRollMs = isLoad ? 0 : (opts.preRollMs ?? DEFAULT_PRE_ROLL_MS);
	if (isLoad && (opts.preJs || opts.preClick.length > 0))
		warnings.push(
			"pre actions with the load trigger run after the page's load animations have started; t=0 moves to after them",
		);
	const waitBeforeMs = isLoad
		? 0
		: (opts.waitBeforeMs ?? DEFAULT_WAIT_BEFORE_MS);
	const frameMs = 1000 / opts.fps;
	const timeAt = (k: number) =>
		Math.sign(k) * Math.round((Math.abs(k) * 1000) / opts.fps);
	const preFrames = Math.round(preRollMs / frameMs);
	let frames = Math.floor(opts.durationMs / frameMs + 1e-9) + 1;
	if (preFrames + frames > MAX_FRAMES) {
		frames = MAX_FRAMES - preFrames;
		warnings.push(
			`capture truncated to ${MAX_FRAMES} frames: last frame at t=${timeAt(frames - 1)}ms instead of ${opts.durationMs}ms`,
		);
	}
	return {
		frameMs,
		preFrames,
		frames,
		waitBeforeMs,
		triggerAtMs:
			FIRST_FRAME_MS + waitBeforeMs + preSettleMs(opts) - timeAt(-preFrames),
		timeAt,
	};
}

export async function captureMotion(
	input: CaptureInput,
): Promise<CaptureSummary> {
	const opts = CaptureOptions.parse(input);
	const url = toUrl(opts.url);
	const outDir = resolve(opts.outDir);
	const framesDir = join(outDir, "frames");
	const warnings: string[] = [];
	const tl = planTimeline(opts, warnings);

	await rm(framesDir, { recursive: true, force: true });
	await mkdir(framesDir, { recursive: true });

	const session = await openSession(opts, warnings);
	try {
		const { page, context, browser } = session;
		page.on("pageerror", (e) => warnings.push(`page error: ${e.message}`));
		const recorder = await startCdpRecorder(await context.newCDPSession(page));
		await installClock(page);
		await page.addInitScript(installRafFlush);
		await page.addInitScript(installPageRuntime, opts.seed);
		await page.goto(url, { waitUntil: "load" });

		const clock = createVirtualClock(page);
		await prepareTrigger(page, opts.trigger);
		const stepMs = Math.max(1, Math.round(tl.frameMs));
		const firstFrameAt = FIRST_FRAME_MS + tl.waitBeforeMs;
		for (let v = FIRST_FRAME_MS; v < firstFrameAt; v += stepMs)
			await clock.advanceTo(v, v - tl.triggerAtMs);
		if (preSettleMs(opts) > 0)
			await clock.advanceTo(firstFrameAt, firstFrameAt - tl.triggerAtMs);
		await runPreActions(
			page,
			clock,
			opts,
			stepMs,
			(v) => v - tl.triggerAtMs,
			warnings,
		);

		// Fixed once, before the first recorded frame: the pre-roll is idle by design, so this equals the trigger-time box.
		const crop = await resolveCrop(page, opts.clip, opts.viewport, warnings);
		const watchCrop = createCropWatcher(crop, warnings);
		const frames: TrackFrame[] = [];
		const truncatedSelectors = new Set<string>();
		let actions: TriggerAction[] = [];

		for (let k = -tl.preFrames; k < tl.frames; k++) {
			const t = tl.timeAt(k);
			await clock.advanceTo(tl.triggerAtMs + t, t);
			if (k === 0)
				actions = await planTrigger(page, opts.trigger, opts.viewport);
			const due = actions.filter((a) => a.atMs <= t);
			if (due.length > 0) {
				actions = actions.filter((a) => a.atMs > t);
				for (const a of due) await a.run();
				await clock.sync(t);
			}
			const sample = await sampleTrack(page, opts.track);
			for (const [sel, count] of Object.entries(sample.truncated)) {
				if (truncatedSelectors.has(sel)) continue;
				truncatedSelectors.add(sel);
				warnings.push(
					`selector ${sel} matched ${count} elements; only the first ${MAX_MATCHES_PER_SELECTOR} are tracked`,
				);
			}
			watchCrop(t, sample.elements);
			const frame = k + tl.preFrames;
			frames.push({
				frame,
				t,
				scrollY: sample.scrollY,
				elements: sample.elements,
			});
			await writeFrame(page, crop, framesDir, frame);
		}
		if (actions.length > 0)
			warnings.push(
				`${actions.length} trigger steps fall after the capture window and were not run`,
			);

		const cdp = await recorder.finish();
		const { records: pageRecords, paths } = await page.evaluate(
			({ selectors, max }) => {
				const rt = (window as unknown as { __motionclone: PageRuntime })
					.__motionclone;
				rt.matchTracked(selectors);
				return {
					records: rt.records,
					paths: rt.trackedPaths(selectors, max),
				};
			},
			{ selectors: opts.track, max: MAX_MATCHES_PER_SELECTOR },
		);
		const animations = mergeAnimations(cdp.animations, pageRecords);
		const stack = await detectStack(page, animations);
		const versions = {
			playwright: (
				createRequire(import.meta.url)("playwright/package.json") as {
					version: string;
				}
			).version,
			browser: browser.version(),
			node: process.version,
		};

		await writeFile(
			join(outDir, "track.json"),
			json({ selectors: opts.track, frameMs: tl.frameMs, frames }),
		);
		await writeFile(
			join(outDir, "animations.json"),
			json({
				animations,
				cdpCreatedWithoutStart: cdp.createdOnly,
				trackedPaths: paths,
			}),
		);
		const summary: CaptureSummary = {
			outDir,
			url,
			frames: frames.length,
			frameMs: tl.frameMs,
			clip: crop,
			animations: animations.length,
			stack,
			warnings,
		};
		await writeFile(
			join(outDir, "capture.json"),
			json({
				options: {
					...opts,
					url,
					outDir,
					preRollMs: tl.timeAt(tl.preFrames),
					waitBeforeMs: tl.waitBeforeMs,
				},
				triggerAtMs: tl.triggerAtMs,
				frames: frames.length,
				frameMs: tl.frameMs,
				clip: crop,
				stack,
				versions,
				warnings,
			}),
		);
		return summary;
	} finally {
		await session.close();
	}
}
