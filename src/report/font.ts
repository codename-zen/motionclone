import type { PNG } from "pngjs";

// Classic 5x7 font for ASCII 32..126: five columns per glyph, bit 0 is the top row.
const COLUMNS = `
00 00 00 00 00|00 00 5F 00 00|00 07 00 07 00|14 7F 14 7F 14|24 2A 7F 2A 12|23 13 08 64 62|36 49 55 22 50|00 05 03 00 00
00 1C 22 41 00|00 41 22 1C 00|14 08 3E 08 14|08 08 3E 08 08|00 50 30 00 00|08 08 08 08 08|00 60 60 00 00|20 10 08 04 02
3E 51 49 45 3E|00 42 7F 40 00|42 61 51 49 46|21 41 45 4B 31|18 14 12 7F 10|27 45 45 45 39|3C 4A 49 49 30|01 71 09 05 03
36 49 49 49 36|06 49 49 29 1E|00 36 36 00 00|00 56 36 00 00|08 14 22 41 00|14 14 14 14 14|00 41 22 14 08|02 01 51 09 06
32 49 79 41 3E|7E 11 11 11 7E|7F 49 49 49 36|3E 41 41 41 22|7F 41 41 22 1C|7F 49 49 49 41|7F 09 09 09 01|3E 41 49 49 7A
7F 08 08 08 7F|00 41 7F 41 00|20 40 41 3F 01|7F 08 14 22 41|7F 40 40 40 40|7F 02 0C 02 7F|7F 04 08 10 7F|3E 41 41 41 3E
7F 09 09 09 06|3E 41 51 21 5E|7F 09 19 29 46|46 49 49 49 31|01 01 7F 01 01|3F 40 40 40 3F|1F 20 40 20 1F|3F 40 38 40 3F
63 14 08 14 63|07 08 70 08 07|61 51 49 45 43|00 7F 41 41 00|02 04 08 10 20|00 41 41 7F 00|04 02 01 02 04|40 40 40 40 40
00 01 02 04 00|20 54 54 54 78|7F 48 44 44 38|38 44 44 44 20|38 44 44 48 7F|38 54 54 54 18|08 7E 09 01 02|0C 52 52 52 3E
7F 08 04 04 78|00 44 7D 40 00|20 40 44 3D 00|7F 10 28 44 00|00 41 7F 40 00|7C 04 18 04 78|7C 08 04 04 78|38 44 44 44 38
7C 14 14 14 08|08 14 14 18 7C|7C 08 04 04 08|48 54 54 54 20|04 3F 44 40 20|3C 40 40 20 7C|1C 20 40 20 1C|3C 40 30 40 3C
44 28 10 28 44|0C 50 50 50 3C|44 64 54 4C 44|00 08 36 41 00|00 00 7F 00 00|00 41 36 08 00|10 08 08 10 08
`;

const GLYPHS = COLUMNS.trim()
	.split(/[|\n]/)
	.map((g) => g.split(" ").map((h) => Number.parseInt(h, 16)));

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
/** Advance per character in glyph pixels: the glyph plus one blank column. */
export const GLYPH_ADVANCE = GLYPH_WIDTH + 1;

export const textWidth = (text: string, scale: number): number =>
	text.length * GLYPH_ADVANCE * scale;

/** Draws `text` with its top-left at (x, y), clipped to the image; characters outside ASCII print as "?". */
export function drawText(
	img: PNG,
	text: string,
	x: number,
	y: number,
	color: readonly [number, number, number],
	scale = 2,
): void {
	[...text].forEach((ch, i) => {
		const code = ch.charCodeAt(0);
		const glyph = GLYPHS[(code >= 32 && code <= 126 ? code : 63) - 32] ?? [];
		glyph.forEach((bits, col) => {
			for (let row = 0; row < GLYPH_HEIGHT; row++) {
				if (!((bits >> row) & 1)) continue;
				for (let dy = 0; dy < scale; dy++)
					for (let dx = 0; dx < scale; dx++) {
						const px = x + (i * GLYPH_ADVANCE + col) * scale + dx;
						const py = y + row * scale + dy;
						if (px < 0 || py < 0 || px >= img.width || py >= img.height)
							continue;
						img.data.set([...color, 255], (py * img.width + px) * 4);
					}
			}
		});
	});
}

/** Greedy word wrap to `chars` columns, hard-breaking words longer than a line. */
export function wrapText(text: string, chars: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		for (let w = word; w.length > 0; w = w.slice(chars)) {
			const part = w.slice(0, chars);
			if (line === "") line = part;
			else if (line.length + 1 + part.length <= chars) line += ` ${part}`;
			else {
				lines.push(line);
				line = part;
			}
		}
	}
	if (line !== "") lines.push(line);
	return lines;
}
