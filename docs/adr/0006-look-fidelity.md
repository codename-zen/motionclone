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
Pixels of the page background colour are not ink either: in a band across a button's edge they are the page around it, and with grayscale text they outweighed the dark text on `look-card-bg`.
Subpixel (LCD) text has fringes of opposite hues that cancel out on average.
When the mean hue of a band's ink is under half its mean chroma, ink pixels with a chroma above 20 are fringes and are left out.
On Windows, near-black `#111111` text drawn with subpixel antialiasing read `#1f1940` (ΔE 19.1) before and reads `#111111` now; coloured text keeps its hue.
Each tracked element (or video region) gets its background and fills inside its box.

## Decision: grayscale text

Chromium on Windows draws subpixel text by default, so a page's measured text colour depended on the OS.
Page captures launch Chromium with `--disable-lcd-text`, which gives grayscale antialiasing everywhere: no text pixel has channels more than 20 levels apart, and `#111111` text measures `#1a1a1a` (ΔE 2.6).
A Chrome attached with `--cdp-url` keeps its own text settings.

## Decision: spec rows

`spec.json` gets a `look` section, separate from motion rows, drafted from the reference's last rest state.
A page reference gets rows read from computed styles: page background, main text colour, up to three accent colours (background colours other than the page's, by area), the title font size (largest type) and body font size (most characters), per tracked element its box, font size and text colour when it has its own text, background when its own is opaque, radius when it has a surface or border, and up to eight untracked blocks (elements whose own background stands out from what is behind them and covers at least 0.5 % of the screen).
A video reference gets rows read from pixels: page background, main text colour, accents (surface colours by area), type sizes, each region's background and type sizes, and up to eight blocks.
Tolerances: CIEDE2000 6 for colours, 3 for backgrounds, sizes 8 % relative, positions 3 % of the screen width or height.
The section also lists the reference's rest frames and the structure settings: blur 8 CSS px, threshold 0.9.

## Decision: type sizes from pixels

A video rebuild with text 20 to 30 % too small passed every look row, and the structure score barely moved (0.957 to 0.963).
Band heights follow line count and glyph shapes, so type sizes come from glyphs instead.
Inside each band, connected ink components are glyphs; their edges are where the ink crosses half its own contrast, interpolated between rows.
Glyphs whose bottoms lie within one pixel share a baseline; a line has at least three of them.
Its cap height runs from the top of its tallest glyph on the baseline (a capital or an ascender) to the median bottom, so descenders and other words do not change it.
Lines within 8 % of each other are one size; main sizes have two lines or more, and the largest size counts with one line.
`look.json` lists them per state and per region in CSS px.
Each line belongs to the first region that holds it, or to the screen.
Per region and for the screen, the three sizes with the most text width become rows, largest first: `look.type#1`, `sheet[0].look.type#1` and so on, with a tolerance of ±8 %.
A row keeps its lines, each with its place in its column (the lines that overlap it across, top to bottom).
The clone is measured from its pixels the same way, never from computed styles.
Each reference line is paired with the clone line of the same place in a column of as many lines, or else with the nearest baseline, within three cap heights; the row compares the median cap height of the pairs.
So other words keep every pair, and a smaller title that moves the lines under it fails only the title row.
Matching sizes by role (largest, most text) failed other words on `look-card`: two sizes with similar text width swapped roles.

## Decision: the text score

The blurred SSIM hides type size: blur that ignores other words also ignores smaller text.
The structure score now has a second number per rest frame, the text score.
For each text band of the reference, read 25 % taller on both sides, the row profile is the mean grey distance from the band's median, averaged along the line and not blurred across it.
The score is the cosine of the reference and clone profiles, weighted by band width; it must reach 0.9.
Words change where ink sits along a line, not across it, so they keep the profile.

## Decision: one rest detector

The design sheet labelled rest frames at 107, 393 and 1107 ms while `look.json` listed still stretches at 1536 ms and later for the same clip.
The sheet had its own detector, which took the first frame of any three nearly equal frames.
It now uses the look's rest states (`src/look/rest.ts`): the middle of each still run and the last frame.

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

On `fixtures/_variants/sheet-flip` (video reference, h264 crf 18, page clones):

| Clone                 | Cap heights (px): screen #1, #2; sheet #1, #2 | Type rows failing | Blurred SSIM (min) | Text score (min) |
| --------------------- | --------------------------------------------- | ----------------- | ------------------ | ---------------- |
| reference (video)     | 17, 11.1; 14, 10                              |                   |                    |                  |
| same page             | 17.1, 11.1; 14, 10.1                          | none              | 0.9997             | 0.9999           |
| other words           | 17.1, 11.1; 14, 10.1                          | none              | 0.991              | 0.993            |
| all text 25 % smaller | 13.1, 8; 9.9, 8 (-20 % to -29 %)              | all four          | 0.945              | 0.55             |

On `look-card` from a video, other words and another background pass every type row; a 34 px title instead of 48 px fails only `look.type#1` (25 px, want 35 px), and its text score drops to 0.18.

The blurred SSIM alone passes the smaller text; the type rows and the text score fail it.

## Alternatives

- Pixel mismatch on rest frames as the look check: other words and images fail it, and against a video it compares codec noise.
- One tolerance for every colour: 6 lets the near-white background that started this pass.
- Type sizes from text-line band heights in video: band height follows line count and glyph shapes, so it would fail other words.
- Text score as SSIM on less-blurred frames inside the bands: other words change the glyphs there as much as a smaller size does.

## Limits

- Video references get no radius or font rows, and type sizes are cap heights, not font sizes; a note gives the font size a cap height of 0.7 em would mean.
- A rebuild that wraps text into more lines in a column is paired by nearest baseline there, which can pair a line with one of another size.
- Rows describe the last rest state; earlier states are covered by the structure score only.
- Text colour from pixels comes from antialiased glyphs: thin light text reads darker or lighter by a few ΔE.
- Photos inside a block break its flat fill, so that block becomes ink and gets no block row.
- Fonts are compared by size, weight and family name in `look.json`; only sizes are rows.

## Consequences

- Every page and video capture writes `look.json`; captures made before it get no look section, and look fidelity reports it as skipped and failing.
- `SpecFile.look` and `Verdict.look` are new, nullable and default to null, so older files still parse.
- `Verdict.fidelity` accepts `look`.
- `PixelLook.type`, `RegionLook.type`, the `text-height` look measure, `structure.textThreshold` and the structure's `text` and `minText` are new and default to empty or null, so older files still parse.
