import { stat } from "node:fs/promises";
import { join } from "node:path";
import { runFfmpegOrThrow } from "../video/ffmpeg.ts";

export const GIF_WARN_BYTES = 8 * 1024 * 1024;

/** Encodes numbered PNGs (00000.png...) as a GIF with a shared palette or an H.264 yuv420p MP4. */
export async function encodeFrames(
	framesDir: string,
	fps: number,
	out: string,
): Promise<number> {
	const input = ["-framerate", String(fps), "-i", join(framesDir, "%05d.png")];
	const gif = out.toLowerCase().endsWith(".gif");
	await runFfmpegOrThrow(
		gif
			? [
					"-v",
					"error",
					"-y",
					...input,
					"-vf",
					"split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
					"-loop",
					"0",
					out,
				]
			: [
					"-v",
					"error",
					"-y",
					...input,
					"-c:v",
					"libx264",
					"-pix_fmt",
					"yuv420p",
					"-crf",
					"18",
					"-movflags",
					"+faststart",
					out,
				],
	);
	return (await stat(out)).size;
}
