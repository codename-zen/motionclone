import type { CaptureArgs } from "./capture-args.ts";
import { runCapture } from "./capture-args.ts";
import {
	assertNoVideoFlags,
	isVideoInput,
	runVideoCapture,
} from "./video-args.ts";

/** Capture a page, or a video file when the input is one; the lines CLI and MCP both print. */
export async function captureLines(a: CaptureArgs): Promise<string[]> {
	if (isVideoInput(a.url)) return runVideoCapture(a);
	assertNoVideoFlags(a);
	const s = await runCapture(a);
	return [
		`captured ${s.frames} frames (${s.frameMs.toFixed(1)} ms each) to ${s.outDir}`,
		`animations: ${s.animations}, stack: ${s.stack.join(", ") || "none"}`,
		...s.warnings.map((w) => `warning: ${w}`),
	];
}
