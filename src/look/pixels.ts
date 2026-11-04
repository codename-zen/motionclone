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
import { inkOf, inkSummary, mainInk } from "./ink.ts";
import { type Grid, gridOf, kmeansPalette, uniformColours } from "./palette.ts";
import { panelOf } from "./panel.ts";
import type {
	Band,
	Box,
	FracBox,
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

/** A region's box as fractions of the frame. */
function frameBox(r: LookRegion, clip: ClipRect, png: PNG): FracBox | null {
	const f = toFrameRect(r.box, clip, png);
	return f
		? {
				x: f.x0 / png.width,
				y: f.y0 / png.height,
				w: (f.x1 - f.x0) / png.width,
				h: (f.y1 - f.y0) / png.height,
			}
		: null;
}

type Ink = { lab: Lab; weight: number };

/**
 * Main ink of the text lines that pass `keep`, each read over its letters against `background`: borders and icons
 * in the same band stay out, and dark text on a white sheet over a dark page is not page colour.
 */
function lineInk(
	png: PNG,
	lines: readonly TypeLine[],
	keep: (l: TypeLine) => boolean,
	background: Lab | null,
	cssPerPx: number,
): { hex: string; share: number } | null {
	const inks = lines.flatMap((l) => {
		if (!keep(l)) return [];
		const y1 = Math.round(l.y * png.height);
		return (
			inkOf(
				png,
				{
					x0: Math.round(l.x * png.width),
					x1: Math.round((l.x + l.w) * png.width),
					y0: Math.max(0, Math.round(y1 - l.cap / cssPerPx)),
					y1,
				},
				background,
			) ?? []
		);
	});
	return inkSummary(inks);
}

function regionLook(
	png: PNG,
	grid: Grid,
	clip: ClipRect,
	r: LookRegion,
	lines: readonly TypeLine[],
): RegionLook | null {
	const f = toFrameRect(r.box, clip, png);
	const frame = frameBox(r, clip, png);
	if (!f || !frame) return null;
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
	const text = lineInk(
		png,
		lines,
		(l) => inBox(l, frame),
		first.lab,
		clip.width / png.width,
	);
	return {
		key: r.key,
		box: r.box,
		background: labToHex(first.lab),
		palette: fills.map((u) => ({
			hex: labToHex(u.lab),
			share: r4(u.count / n),
		})),
		type: typeSizes(lines.filter((l) => inBox(l, frame))),
		text: text?.hex ?? null,
		textShare: text?.share ?? null,
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
	const inks: Ink[] = [];
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
	const looks = regions.flatMap(
		(r) => regionLook(png, grid, clip, r, lines) ?? [],
	);
	const frames = regions.flatMap((r) => frameBox(r, clip, png) ?? []);
	const outside =
		looks.length > 0
			? lineInk(
					png,
					lines,
					(l) => !frames.some((f) => inBox(l, f)),
					page,
					clip.width / png.width,
				)
			: null;
	const total = grid.cols * grid.rows;
	const byColour = new Map<number, number>();
	for (const s of list)
		byColour.set(s.colour, (byColour.get(s.colour) ?? 0) + s.cells);
	const surfaceSwatches: Swatch[] = [...byColour]
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => ({ hex: labToHex(labs[k] as Lab), share: r4(n / total) }));
	return {
		background: fills[0] ? labToHex(fills[0].lab) : "#ffffff",
		// Read over each line's letters against what is behind them, so text on a sheet is not judged by the page.
		text:
			lines.length > 0
				? (lineInk(png, lines, () => true, null, clip.width / png.width)?.hex ??
					mainInk(inks))
				: mainInk(inks),
		palette: kmeansPalette(grid.lab, labs),
		surfaces: surfaceSwatches,
		regions: looks,
		blocks,
		bands,
		type: typeSizes(lines),
		lines,
		outsideText: outside?.hex ?? null,
		outsideTextShare: outside?.share ?? null,
		panel: panelOf(png, blocks, clip.width / png.width),
	};
}
