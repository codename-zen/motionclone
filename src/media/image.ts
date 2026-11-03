import { PNG } from "pngjs";

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type Rgb = readonly [number, number, number];

export function parseRect(text: string): Rect {
	const n = text.split(",").map((s) => Number(s.trim()));
	const [x, y, width, height] = n as [number, number, number, number];
	if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || width < 1)
		throw new Error(`crop "${text}" must be x,y,w,h in pixels`);
	if (height < 1) throw new Error(`crop "${text}" must be x,y,w,h in pixels`);
	return { x, y, width, height };
}

export function fill(img: PNG, color: Rgb): void {
	for (let i = 0; i < img.data.length; i += 4) img.data.set([...color, 255], i);
}

export function blank(width: number, height: number, color: Rgb): PNG {
	const img = new PNG({ width, height });
	fill(img, color);
	return img;
}

/** Cut a rectangle out of the image, clamped to its bounds. */
export function crop(src: PNG, r: Rect): PNG {
	const x = Math.max(0, Math.min(src.width - 1, Math.floor(r.x)));
	const y = Math.max(0, Math.min(src.height - 1, Math.floor(r.y)));
	const width = Math.max(1, Math.min(src.width - x, Math.floor(r.width)));
	const height = Math.max(1, Math.min(src.height - y, Math.floor(r.height)));
	const out = new PNG({ width, height });
	PNG.bitblt(src, out, x, y, width, height, 0, 0);
	return out;
}

/** Area-average resample: each output pixel averages the source pixels it covers. */
export function resize(src: PNG, width: number, height: number): PNG {
	if (src.width === width && src.height === height) return src;
	const out = new PNG({ width, height });
	const sx = src.width / width;
	const sy = src.height / height;
	for (let y = 0; y < height; y++) {
		const y0 = Math.floor(y * sy);
		const y1 = Math.min(src.height, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
		for (let x = 0; x < width; x++) {
			const x0 = Math.floor(x * sx);
			const x1 = Math.min(src.width, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
			let r = 0;
			let g = 0;
			let b = 0;
			for (let yy = y0; yy < y1; yy++)
				for (let xx = x0; xx < x1; xx++) {
					const p = (yy * src.width + xx) * 4;
					r += src.data[p] as number;
					g += src.data[p + 1] as number;
					b += src.data[p + 2] as number;
				}
			const n = (y1 - y0) * (x1 - x0);
			out.data.set(
				[Math.round(r / n), Math.round(g / n), Math.round(b / n), 255],
				(y * width + x) * 4,
			);
		}
	}
	return out;
}

/** Scale to fit inside width x height keeping the aspect ratio, centred on a padded background. */
export function fitInto(
	src: PNG,
	width: number,
	height: number,
	pad: Rgb,
): PNG {
	const k = Math.min(width / src.width, height / src.height);
	const w = Math.max(1, Math.min(width, Math.round(src.width * k)));
	const h = Math.max(1, Math.min(height, Math.round(src.height * k)));
	const scaled = resize(src, w, h);
	if (w === width && h === height) return scaled;
	const out = blank(width, height, pad);
	PNG.bitblt(
		scaled,
		out,
		0,
		0,
		w,
		h,
		Math.floor((width - w) / 2),
		Math.floor((height - h) / 2),
	);
	return out;
}
