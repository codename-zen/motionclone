import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CaptureInput, captureMotion } from "../src/capture/index.ts";
import { type StaticServer, serveRepo } from "./serve.ts";

export const FADE = { durationMs: 1500, fps: 30, track: [".card", "h1"] };
export const SPRING = {
	durationMs: 800,
	fps: 30,
	track: [".box"],
	trigger: { type: "click", target: ".go" },
} satisfies Partial<CaptureInput>;
export const GSAP = { durationMs: 1300, fps: 60, track: [".item"] };

export interface CaptureSession {
	/** Capture fixtures/<path>/index.html into a fresh directory named `name`; returns that directory. */
	capture(
		path: string,
		name: string,
		opts: Partial<CaptureInput>,
	): Promise<string>;
	close(): Promise<void>;
}

export async function openCaptureSession(
	prefix: string,
): Promise<CaptureSession> {
	const server: StaticServer = await serveRepo();
	const root = await mkdtemp(join(tmpdir(), `motionclone-${prefix}-`));
	return {
		async capture(path, name, opts) {
			const summary = await captureMotion({
				durationMs: 1000,
				...opts,
				url: `${server.url}/fixtures/${path}/index.html`,
				outDir: join(root, name),
			});
			return summary.outDir;
		},
		async close() {
			await server.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}
