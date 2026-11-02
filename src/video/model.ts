import { gaussian } from "./blur.ts";
import type { Plane } from "./luma.ts";
import { COARSE, type Frame, type Grid, gridOf, type Rect } from "./match.ts";

export type LevelName = "full" | "half" | "coarse";
export const FACTOR: Record<LevelName, number> = {
	full: 1,
	half: 2,
	coarse: COARSE,
};
const CACHE_SIZE = 48;
// The pad beyond the window the blurred source needs: three sigmas plus the bilinear neighbour.
const PAD_SIGMAS = 3;

interface Source {
	plane: Plane;
	x0: number;
	y0: number;
}

// Linear steps for small sigmas, 2 % steps above, so neighbouring frames share blurred sources.
const quantise = (s: number) =>
	s < 0.05
		? 0
		: s < 2
			? Math.round(s * 20) / 20
			: Math.exp(Math.round(Math.log(s) * 50) / 50);

/**
 * The reference appearance of one element, rendered as it would look scaled by `s` about the window centre
 * and blurred by `blur` reference-frame pixels before scaling (CSS applies a filter in the element's own space).
 */
export class TemplateModel {
	readonly win: Rect;
	private readonly ref: Frame;
	private readonly cache = new Map<string, Source>();

	constructor(ref: Frame, win: Rect) {
		this.ref = ref;
		this.win = win;
	}

	/** Window size at a level and scale, in that level's pixels. */
	size(level: LevelName, s: number) {
		const f = FACTOR[level];
		return {
			w: Math.max(1, Math.round((s * this.win.w) / f)),
			h: Math.max(1, Math.round((s * this.win.h) / f)),
		};
	}

	private source(level: LevelName, sigma: number): Source {
		const key = `${level}:${sigma}`;
		const hit = this.cache.get(key);
		if (hit) return hit;
		const f = FACTOR[level];
		const p = this.ref[level];
		const pad = Math.ceil(PAD_SIGMAS * sigma) + 2;
		const x0 = Math.floor(this.win.x / f) - pad;
		const y0 = Math.floor(this.win.y / f) - pad;
		const w = Math.ceil(this.win.w / f) + 2 * pad + 1;
		const h = Math.ceil(this.win.h / f) + 2 * pad + 1;
		const data = new Float32Array(w * h);
		for (let j = 0; j < h; j++) {
			const sy = Math.min(p.height - 1, Math.max(0, y0 + j));
			for (let i = 0; i < w; i++) {
				const sx = Math.min(p.width - 1, Math.max(0, x0 + i));
				data[j * w + i] = p.data[sy * p.width + sx] as number;
			}
		}
		const src = {
			plane: gaussian({ width: w, height: h, data }, sigma),
			x0,
			y0,
		};
		if (this.cache.size >= CACHE_SIZE)
			this.cache.delete(this.cache.keys().next().value as string);
		this.cache.set(key, src);
		return src;
	}

	/** Zero-mean template at a level; its centre is the window centre moved by (ox, oy) level pixels. */
	render(level: LevelName, s: number, blur: number, ox = 0, oy = 0): Grid {
		const f = FACTOR[level];
		// Shrinking by 1/s averages about 1/s source pixels: a box of that width has variance (d^2 - 1) / 12.
		const shrink = Math.max(0, 1 / (s * s) - 1) / 12;
		const sigma = quantise(Math.sqrt((blur / f) ** 2 + shrink));
		const src = this.source(level, sigma);
		const { w, h } = this.size(level, s);
		const cx = (this.win.x + this.win.w / 2) / f;
		const cy = (this.win.y + this.win.h / 2) / f;
		const sp = src.plane;
		const t = new Float32Array(w * h);
		for (let j = 0; j < h; j++) {
			const v = cy + (j + 0.5 - h / 2 - oy) / s - 0.5 - src.y0;
			const y = Math.min(sp.height - 2, Math.max(0, Math.floor(v)));
			const fy = Math.min(1, Math.max(0, v - y));
			for (let i = 0; i < w; i++) {
				const u = cx + (i + 0.5 - w / 2 - ox) / s - 0.5 - src.x0;
				const x = Math.min(sp.width - 2, Math.max(0, Math.floor(u)));
				const fx = Math.min(1, Math.max(0, u - x));
				const o = y * sp.width + x;
				const top =
					(sp.data[o] as number) * (1 - fx) + (sp.data[o + 1] as number) * fx;
				const bottom =
					(sp.data[o + sp.width] as number) * (1 - fx) +
					(sp.data[o + sp.width + 1] as number) * fx;
				t[j * w + i] = top * (1 - fy) + bottom * fy;
			}
		}
		return gridOf(t, w, h);
	}
}
