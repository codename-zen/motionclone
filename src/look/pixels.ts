import type { PNG } from "pngjs";
import type { ClipRect } from "../capture/options.ts";
import { toFrameRect } from "../pixel/region.ts";
import {
	bandsOf,
	blocksOf,
	type CellRect,
	labelCells,
	surfaces,
} from "./blocks.ts";
import { deltaE2000, type Lab, labToHex, rgbToLab } from "./colour.ts";
import { type Grid, gridOf, kmeansPalette, uniformColours } from "./palette.ts";
import type { Band, Box, PixelLook, RegionLook, Swatch } from "./schema.ts";

export interface LookRegion {
	key: string;
	box: Box;
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const r1 = (v: number) => Math.round(v * 10) / 10;

// Ink is at least this far from the band's background (Lab units).
const INK = 20;
const MAX_PIXELS = 4000;
const SAME_INK_DE = 6;

/** Lab of the frame pixels in a rectangle, sampled to at most MAX_PIXELS. */
function pixelsIn(
	png: PNG,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): Float32Array {
	const step = Math.max(
		1,
		Math.ceil(Math.sqrt(((x1 - x0) * (y1 - y0)) / MAX_PIXELS)),
	);
	const out: number[] = [];
	for (let y = y0; y < y1; y += step)
		for (let x = x0; x < x1; x += step) {
			const p = (y * png.width + x) * 4;
			const c = rgbToLab(
				png.data[p] as number,
				png.data[p + 1] as number,
				png.data[p + 2] as number,
			);
			out.push(c.l, c.a, c.b);
		}
	return Float32Array.from(out);
}

/** The ink colour of a text band: the quarter of its pixels farthest from the band's background. */
function inkOf(
	png: PNG,
	r: { x0: number; y0: number; x1: number; y1: number },
) {
	const p = pixelsIn(png, r.x0, r.y0, r.x1, r.y1);
	const bg = uniformColours(p, { max: 1, minShare: 0 })[0]?.lab;
	if (!bg) return null;
	const far: { d: number; i: number }[] = [];
	for (let i = 0; i < p.length / 3; i++) {
		const d = Math.hypot(
			(p[i * 3] as number) - bg.l,
			(p[i * 3 + 1] as number) - bg.a,
			(p[i * 3 + 2] as number) - bg.b,
		);
		if (d > INK) far.push({ d, i });
	}
	if (far.length < 8) return null;
	far.sort((a, b) => b.d - a.d);
	const top = far.slice(0, Math.max(4, Math.ceil(far.length / 4)));
	const m = { l: 0, a: 0, b: 0 };
	for (const { i } of top) {
		m.l += p[i * 3] as number;
		m.a += p[i * 3 + 1] as number;
		m.b += p[i * 3 + 2] as number;
	}
	return {
		lab: { l: m.l / top.length, a: m.a / top.length, b: m.b / top.length },
		weight: far.length,
	};
}

/** The ink colour with the most pixels over all bands, similar inks pooled. */
function mainInk(inks: { lab: Lab; weight: number }[]): string | null {
	const groups: { lab: Lab; weight: number }[] = [];
	for (const ink of [...inks].sort((a, b) => b.weight - a.weight)) {
		const g = groups.find((x) => deltaE2000(x.lab, ink.lab) < SAME_INK_DE);
		if (!g) {
			groups.push({ ...ink, lab: { ...ink.lab } });
			continue;
		}
		const w = g.weight + ink.weight;
		g.lab = {
			l: (g.lab.l * g.weight + ink.lab.l * ink.weight) / w,
			a: (g.lab.a * g.weight + ink.lab.a * ink.weight) / w,
			b: (g.lab.b * g.weight + ink.lab.b * ink.weight) / w,
		};
		g.weight = w;
	}
	const best = groups.sort((a, b) => b.weight - a.weight)[0];
	return best ? labToHex(best.lab) : null;
}

function regionLook(
	png: PNG,
	grid: Grid,
	clip: ClipRect,
	r: LookRegion,
): RegionLook | null {
	const f = toFrameRect(r.box, clip, png);
	if (!f) return null;
	const c = grid.cell;
	const out: number[] = [];
	for (
		let y = Math.floor(f.y0 / c);
		y < Math.min(grid.rows, Math.ceil(f.y1 / c));
		y++
	)
		for (
			let x = Math.floor(f.x0 / c);
			x < Math.min(grid.cols, Math.ceil(f.x1 / c));
			x++
		) {
			const o = (y * grid.cols + x) * 3;
			out.push(
				grid.lab[o] as number,
				grid.lab[o + 1] as number,
				grid.lab[o + 2] as number,
			);
		}
	const n = out.length / 3;
	const fills = uniformColours(Float32Array.from(out), {
		max: 4,
		minShare: 0.02,
	});
	const first = fills[0];
	if (!first) return null;
	return {
		key: r.key,
		box: r.box,
		background: labToHex(first.lab),
		palette: fills.map((u) => ({
			hex: labToHex(u.lab),
			share: r4(u.count / n),
		})),
	};
}

/** Colours, flat surfaces, blocks and text bands of one frame; boxes in fractions of the frame. */
export function pixelLook(
	png: PNG,
	clip: ClipRect,
	regions: LookRegion[] = [],
): PixelLook {
	const grid = gridOf(png);
	const fills = uniformColours(grid.lab);
	const labs = fills.map((u) => u.lab);
	const labels = labelCells(grid, labs);
	const { list, member } = surfaces(grid, labels);
	const cellCss = (grid.cell * clip.width) / png.width;
	const frac = (r: CellRect) => ({
		x: r4((r.x * grid.cell) / png.width),
		y: r4((r.y * grid.cell) / png.height),
		w: r4((r.w * grid.cell) / png.width),
		h: r4((r.h * grid.cell) / png.height),
	});
	const blocks = blocksOf(grid, list, 0, Math.max(2, Math.ceil(8 / cellCss)))
		.slice(0, 16)
		.map((s) => ({
			...frac(s),
			hex: labToHex(labs[s.colour] as Lab),
			fill: r4(s.fill),
		}));
	const inks: { lab: Lab; weight: number }[] = [];
	const bands: Band[] = bandsOf(grid, member, Math.ceil(24 / cellCss))
		.slice(0, 80)
		.map((b) => {
			const ink = inkOf(png, {
				x0: b.x * grid.cell,
				y0: b.y * grid.cell,
				x1: (b.x + b.w) * grid.cell,
				y1: (b.y + b.h) * grid.cell,
			});
			if (ink) inks.push(ink);
			return {
				...frac(b),
				hex: ink ? labToHex(ink.lab) : null,
				px: r1(b.h * cellCss),
			};
		});
	const total = grid.cols * grid.rows;
	const byColour = new Map<number, number>();
	for (const s of list)
		byColour.set(s.colour, (byColour.get(s.colour) ?? 0) + s.cells);
	const surfaceSwatches: Swatch[] = [...byColour]
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => ({ hex: labToHex(labs[k] as Lab), share: r4(n / total) }));
	return {
		background: fills[0] ? labToHex(fills[0].lab) : "#ffffff",
		text: mainInk(inks),
		palette: kmeansPalette(grid.lab, labs),
		surfaces: surfaceSwatches,
		regions: regions.flatMap((r) => regionLook(png, grid, clip, r) ?? []),
		blocks,
		bands,
	};
}
