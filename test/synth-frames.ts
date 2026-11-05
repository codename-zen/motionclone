import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

/** Luma 0..255 of frame k at (x, y). */
export type Draw = (k: number, x: number, y: number) => number;

/** Write `frames` grey PNG frames of the given size to a new capture directory; returns the directory. */
export async function writeFrames(
	name: string,
	width: number,
	height: number,
	frames: number,
	draw: Draw,
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `motionclone ${name}-`));
	await mkdir(join(dir, "frames"));
	for (let k = 0; k < frames; k++) {
		const png = new PNG({ width, height });
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++) {
				const v = Math.max(0, Math.min(255, Math.round(draw(k, x, y))));
				const o = (y * width + x) * 4;
				png.data[o] = v;
				png.data[o + 1] = v;
				png.data[o + 2] = v;
				png.data[o + 3] = 255;
			}
		await writeFile(
			join(dir, "frames", `${String(k).padStart(4, "0")}.png`),
			PNG.sync.write(png),
		);
	}
	return dir;
}

/** A fixed pseudo-random texture value at (x, y), 0..1. */
export const grain = (x: number, y: number) => {
	const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
	return s - Math.floor(s);
};
