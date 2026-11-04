import { spawn } from "node:child_process";
import { ffmpegBinary } from "./ffmpeg.ts";

/**
 * Decode the first video stream as raw 8-bit frames of `bytesPerPixel` channels and hand each one to `onFrame`.
 * The buffer passed to `onFrame` is reused, so copy it to keep it.
 */
export function decodeRaw(
	input: string,
	{
		width,
		height,
		pixFmt,
		bytesPerPixel,
		filters,
	}: {
		width: number;
		height: number;
		pixFmt: "gray" | "rgb24";
		bytesPerPixel: number;
		filters?: string;
	},
	onFrame: (frame: Uint8Array, index: number) => void,
): Promise<number> {
	const size = width * height * bytesPerPixel;
	const args = ["-hide_banner", "-nostdin", "-v", "error", "-i", input];
	args.push("-map", "0:v:0", "-fps_mode", "passthrough");
	if (filters) args.push("-vf", filters);
	args.push("-f", "rawvideo", "-pix_fmt", pixFmt, "-");
	return new Promise((ok, fail) => {
		const child = spawn(ffmpegBinary(), args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const frame = new Uint8Array(size);
		let filled = 0;
		let count = 0;
		let failed: Error | null = null;
		const errors: Buffer[] = [];
		child.stderr.on("data", (c: Buffer) => errors.push(c));
		child.stdout.on("data", (chunk: Buffer) => {
			let at = 0;
			while (at < chunk.length && !failed) {
				const take = Math.min(size - filled, chunk.length - at);
				frame.set(chunk.subarray(at, at + take), filled);
				filled += take;
				at += take;
				if (filled === size) {
					try {
						onFrame(frame, count++);
					} catch (e) {
						failed = e as Error;
						child.kill();
					}
					filled = 0;
				}
			}
		});
		child.on("error", fail);
		child.on("close", (code) => {
			if (failed) return fail(failed);
			if (code !== 0)
				return fail(
					new Error(
						`ffmpeg failed (${code}): ${Buffer.concat(errors).toString("utf8").trim().split(/\r?\n/).slice(-3).join(" | ")}`,
					),
				);
			ok(count);
		});
	});
}
