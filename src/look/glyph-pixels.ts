import type { PNG } from "pngjs";

/** Largest channel difference of each pixel from the most common colour of the rectangle. */
export function distances(
	png: PNG,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
) {
	const w = x1 - x0;
	const px = (x: number, y: number) => (y * png.width + x) * 4;
	const bins = new Map<number, number>();
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const p = px(x, y);
			const key =
				((png.data[p] as number) >> 4) * 256 +
				((png.data[p + 1] as number) >> 4) * 16 +
				((png.data[p + 2] as number) >> 4);
			bins.set(key, (bins.get(key) ?? 0) + 1);
		}
	let key = 0;
	let most = -1;
	for (const [k, n] of bins)
		if (n > most) {
			most = n;
			key = k;
		}
	const bg = [key >> 8, (key >> 4) & 15, key & 15].map((v) => v * 16 + 8);
	const d = new Float32Array(w * (y1 - y0));
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const p = px(x, y);
			let m = 0;
			for (let c = 0; c < 3; c++)
				m = Math.max(
					m,
					Math.abs((png.data[p + c] as number) - (bg[c] as number)),
				);
			d[(y - y0) * w + x - x0] = m;
		}
	return d;
}

/** Pixels connected to `start` that pass `ok`, marking each in `mark`; diagonal neighbours count when `diagonal`. */
export function flood(
	start: number,
	w: number,
	h: number,
	ok: (j: number) => boolean,
	mark: Uint8Array,
	diagonal: boolean,
): number[] {
	const stack = [start];
	const pixels: number[] = [];
	mark[start] = 1;
	while (stack.length) {
		const i = stack.pop() as number;
		pixels.push(i);
		const x = i % w;
		const y = (i - x) / w;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				if ((dx === 0 && dy === 0) || (!diagonal && dx !== 0 && dy !== 0))
					continue;
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
				const j = ny * w + nx;
				if (!mark[j] && ok(j)) {
					mark[j] = 1;
					stack.push(j);
				}
			}
	}
	return pixels;
}
