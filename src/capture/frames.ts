import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import type { CaptureOptions, ClipRect } from "./options.ts";

export async function resolveCrop(
	page: Page,
	clip: CaptureOptions["clip"],
	viewport: { width: number; height: number },
	warnings: string[],
): Promise<ClipRect> {
	let rect: ClipRect = { x: 0, y: 0, ...viewport };
	if (clip && "selector" in clip) {
		const box = await page.locator(clip.selector).first().boundingBox();
		if (!box)
			throw new Error(
				`clip selector matched no visible element: ${clip.selector}`,
			);
		rect = {
			x: box.x - clip.pad,
			y: box.y - clip.pad,
			width: box.width + clip.pad * 2,
			height: box.height + clip.pad * 2,
		};
	} else if (clip) {
		rect = clip;
	}
	// Whole pixels keep every frame the same size; clamp to the viewport so screenshots never fail.
	const x0 = Math.max(0, Math.floor(rect.x));
	const y0 = Math.max(0, Math.floor(rect.y));
	const x1 = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
	const y1 = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
	if (x1 <= x0 || y1 <= y0) throw new Error("crop lies outside the viewport");
	const out = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
	if (
		out.x !== Math.floor(rect.x) ||
		out.y !== Math.floor(rect.y) ||
		x1 !== Math.ceil(rect.x + rect.width) ||
		y1 !== Math.ceil(rect.y + rect.height)
	) {
		warnings.push(`crop clamped to the viewport: ${JSON.stringify(out)}`);
	}
	return out;
}

export async function writeFrame(
	page: Page,
	crop: ClipRect,
	framesDir: string,
	index: number,
): Promise<Buffer> {
	const png = await page.screenshot({
		clip: crop,
		animations: "allow",
		caret: "hide",
		type: "png",
		scale: "device",
	});
	await writeFile(
		join(framesDir, `${String(index).padStart(4, "0")}.png`),
		png,
	);
	return png;
}
