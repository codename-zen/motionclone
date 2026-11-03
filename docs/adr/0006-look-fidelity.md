# ADR 0006: look fidelity

## Status

Accepted, 2026-11-03.

## Context

Rebuilds that passed every motion row still looked different from their reference: another background colour, other font sizes, other proportions.
Verify only measured motion, and against a video reference it skipped rest-frame pixels entirely, so nothing told the agent which colour or size to copy.
Plain pixel comparison cannot fill the gap, because the rebuild is the user's own: other words and images in the same design must pass.

## Decision: what a capture records

A page capture writes `look.json` next to its frames.
At the first frame that is pixel-identical to the one before it, and at the last frame, it records every visible element under the target (the clip selector, or `body`): box, resolved font family (the first family in the list the browser has), font size, weight, line height, letter spacing, colour, background, the opaque background behind it, top-left radius, border, box shadow and opacity including its ancestors.
Visible means displayed, not hidden, an opacity above 0.01 and a box inside the crop; at most 600 elements are kept, with a capture warning beyond that.
Colours are normalised in the page through a canvas, so every CSS colour syntax ends up as `#rrggbb` or `#rrggbbaa`.
The same states also get a pixel look, and the last one a design summary: background colours by the area they show, text colours by characters, the type scale with weights, families and example text, radii, and the common gaps between neighbouring boxes.
A video capture writes the same file from pixels only, at the middle of the still run before the first change, of every plateau of at least 150 ms between changes, and at the last frame.
A frame is still when no tile of an 8 x 8 grid changes by more than the rest level of ADR 0005; the whole-frame mean missed light cards fading on white, which change the frame by under 0.5 levels.

## Decision: the pixel look

The frame is averaged over cells (3 px for a 1280 px frame) and converted to CIE Lab.
Flat fills are found by mode seeking: the most common colour bin, every cell within 3 Lab units of its mean, then the next among what is left.
The first fill is the background.
The palette is k-means in Lab seeded with the fills plus the farthest leftovers, with clusters closer than 1.5 CIEDE2000 merged.
Connected cells of one fill covering at least 0.3 % of the frame are surfaces; those that are not the background, fill at least half of their bounding box and are at least 8 CSS px on each side are blocks.
Cells on no surface are ink: their row projection gives text-line bands, split where 24 CSS px of columns have none.
A band's ink colour is the mean of the quarter of its pixels farthest from the band's own background; the main text colour is the ink with the most pixels, similar inks pooled.
Each tracked element (or video region) gets its background and fills inside its box.

## Decision: spec rows

`spec.json` gets a `look` section, separate from motion rows, drafted from the reference's last rest state.
A page reference gets rows read from computed styles: page background, main text colour, up to three accent colours (background colours other than the page's, by area), the title font size (largest type) and body font size (most characters), per tracked element its box, font size and text colour when it has its own text, background when its own is opaque, radius when it has a surface or border, and up to eight untracked blocks (elements whose own background stands out from what is behind them and covers at least 0.5 % of the screen).
A video reference gets rows read from pixels: page background, main text colour, accents (surface colours by area), each region's background and up to eight blocks.
Tolerances: CIEDE2000 6 for colours, 3 for backgrounds, sizes 8 % relative, positions 3 % of the screen width or height.
The section also lists the reference's rest frames and the structure settings: blur 8 CSS px, threshold 0.9.

## Decision: verify

Fidelity `look` checks motion rows as before plus the look rows and the structure score; fidelity `pixel` includes look and adds the rest-frame pixel threshold; fidelity `motion` is unchanged and computes no look.
The clone is measured the way the reference was (ADR 0004): style rows read the clone's own `look.json`, pixel rows read the clone's frame with the reference's last rest index through the same pixel look, with `--map` applied to element names.
Content cannot fail a row by itself: colours are matched by surface and area (an accent passes when the clone shows any surface within tolerance), sizes by role (largest type, most text), and blocks by colour and overlap.
The structure score is SSIM of grayscale frames, area-averaged to 320 px wide and blurred by 8 CSS px, on every reference rest frame against the clone frame with the same index; each must reach 0.9.
Failing rows carry the fix with both values, such as "page background is #f4f7f1, want #ffffff (ΔE 4.1 > 3)" or "title font size 34 px, want 48 px (-29 %, allowed ±8 %)", and the report lists them under Fix and in a Look section.
Pixel fidelity against a video reference stays a setup error that now points to look fidelity.

## Measurements

On `fixtures/look-card` (1280 x 800, load trigger, 1200 ms) against variants of it:

| Clone               | Page reference: failing look rows       | Structure (first, last) | Video reference (h264 crf 18, 30 fps): failing look rows | Structure     |
| ------------------- | --------------------------------------- | ----------------------- | -------------------------------------------------------- | ------------- |
| same page           | none                                    | 1.000, 1.000            | none                                                     | 1.000, 0.9996 |
| background #f4f7f1  | page background, ΔE 4.1                 | 0.999, 0.984            | page background, ΔE 4.1                                  | 0.999, 0.983  |
| title 34 px, not 48 | title size, `.title[0]` size and height | 0.939, 0.878            | none                                                     | 0.939, 0.877  |
| other words         | none                                    | 0.994, 0.990            | none                                                     | 0.994, 0.990  |

From the video, the same page as a DOM clone is within ΔE 0.8 on the card and accent fills, ΔE 1.5 on the main text colour, and within 3 px on every block.
The structure threshold of 0.9 sits between other words (0.990) and the smaller title (0.878); the background tolerance of 3 fails the 4.1 of a near-white background and leaves room over the 0.8 of the video's fills.

## Alternatives

- Pixel mismatch on rest frames as the look check: other words and images fail it, and against a video it compares codec noise.
- One tolerance for every colour: 6 lets the near-white background that started this pass.
- Type sizes from text-line band heights in video: band height follows line count and glyph shapes, so it would fail other words; video rows carry no type sizes.

## Limits

- Video references get no type, radius or font rows; the bands in `look.json` only describe line heights.
- Rows describe the last rest state; earlier states are covered by the structure score only.
- Text colour from pixels comes from antialiased glyphs: thin light text reads darker or lighter by a few ΔE.
- Photos inside a block break its flat fill, so that block becomes ink and gets no block row.
- Fonts are compared by size, weight and family name in `look.json`; only sizes are rows.

## Consequences

- Every page and video capture writes `look.json`; captures made before it get no look section, and look fidelity reports it as skipped and failing.
- `SpecFile.look` and `Verdict.look` are new, nullable and default to null, so older files still parse.
- `Verdict.fidelity` accepts `look`.
