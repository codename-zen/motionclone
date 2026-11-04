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
import { type Lab, labToHex } from "./colour.ts";
import { inkOf, mainInk } from "./ink.ts";
import { type Grid, gridOf, kmeansPalette, uniformColours } from "./palette.ts";
import type {
	Band,
	Box,
	PixelLook,
	RegionLook,
	Swatch,
	TypeLine,
} from "./schema.ts";
import { inBox, textLines, typeLines, typeSizes } from "./type.ts";

export interface LookRegion {
	key: string;
	box: Box;
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const r1 = (v: number) => Math.round(v * 10) / 10;
const WHITE: Lab = { l: 100, a: 0, b: 0 };

function regionLook(
	png: PNG,
	grid: Grid,
	clip: ClipRect,
	r: LookRegion,
	lines: readonly TypeLine[],
): RegionLook | null {
	const f = toFrameRect(r.box, clip, png);
	if (!f) return null;
	const frame = {
		x: f.x0 / png.width,
		y: f.y0 / png.height,
		w: (f.x1 - f.x0) / png.width,
		h: (f.y1 - f.y0) / png.height,
	};
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
		type: typeSizes(lines.filter((l) => inBox(l, frame))),
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
	const page = labs[0] ?? WHITE;
	const cellBands = bandsOf(grid, member, Math.ceil(24 / cellCss)).slice(0, 80);
	const lines = typeLines(
		textLines(png, cellBands, grid.cell),
		png,
		clip.width / png.width,
	);
	const bands: Band[] = cellBands.map((b) => {
		const ink = inkOf(
			png,
			{
				x0: b.x * grid.cell,
				y0: b.y * grid.cell,
				x1: (b.x + b.w) * grid.cell,
				y1: (b.y + b.h) * grid.cell,
			},
			page,
		);
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
		regions: regions.flatMap(
			(r) => regionLook(png, grid, clip, r, lines) ?? [],
		),
		blocks,
		bands,
		type: typeSizes(lines),
		lines,
	};
}
