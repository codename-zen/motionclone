# motionclone guide

The README covers the basics.
This page has the details.

## Capture options

Run `motionclone capture --help` for the full list.
The ones you will use most:

| Option                    | What it does                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--track "css, css"`      | Elements to measure on every frame. Every match counts, so `.card` measures all cards.                                                                    |
| `--duration <ms>`         | How long to record after the trigger.                                                                                                                     |
| `--trigger <type>`        | What starts the motion: `load` (default), `none` for loops, `hover`, `leave`, `click` (with `--target <css>`), `scroll` (with `--scroll-to <px or css>`). |
| `--like <dir>`            | Record with the same settings as an earlier capture. Use it for your rebuild.                                                                             |
| `--pre-click <css>`       | Click something before the trigger, for example a cookie banner button. Repeat it for more clicks.                                                        |
| `--pre-js <code or file>` | Run JavaScript in the page before the trigger.                                                                                                            |
| `--storage-state <file>`  | Use a saved Playwright login for pages behind a login.                                                                                                    |
| `--cdp-url <url>`         | Record a Chrome you already have open and logged in.                                                                                                      |

`--pre-click` and `--pre-js` run after `--wait-before` and before the recording starts.
A selector that matches nothing is skipped with a warning.
With the `load` trigger the page's own load animations have already started by then, so use `--trigger none` or `click` if the motion should start after the banner is gone.

Recordings are repeatable: the page runs on a clock that motionclone moves forward frame by frame, so two recordings of the same page are identical.
Text is drawn with grayscale antialiasing on every OS, so text colours measure the same on Windows, macOS and Linux.
A Chrome you attach with `--cdp-url` keeps its own text settings.
That is why motionclone refuses to compare two recordings made with different settings.

## Video and gif

```sh
motionclone probe loader.mov --screen --sheet probe
motionclone capture loader.mov --out ref --start 0:03 --end 0:05 --crop 320,180,960,540 \
  --region "card[0]=40,60,280,160" --region "card[1]=340,60,280,160"
```

`probe` prints the size, frame rate and length of the recording.
When a phone or browser screen sits inside a larger frame, it also finds that screen and suggests `--crop` and `--css-scale`, from the width of common phones (390, 393, 402, 430 CSS px and others).
It lists the time windows where the screen moves, so you can pick `--start` and `--end`.
`--screen` prints the screen guess even when it is unsure.
`--sheet <dir>` writes `contact-sheet.png`, one labelled frame every `--every` ms, cropped to the screen.

- `--region name=x,y,w,h` marks one element to follow, in video pixels after the crop.
  Draw the box around everywhere the element goes during the clip.
  `card[0]` and `card[1]` are measured as a group, like sibling elements on a page.
- Without `--region`, motionclone looks for moving shapes by itself and names them `blob[0]`, `blob[1]` and so on.
  A panel that slides past the edge of the screen is followed by the part that stays in view, and what it reveals or covers gets its own region.
- `--css-scale 2` turns a recording of a 2x screen into CSS pixels.
  The crop is trimmed at the right and bottom to a whole number of CSS pixels, and a warning shows the new crop.
- Pick `--start` after any other content in the same spot has gone, so the region only shows the element you want.

To check your page against the video, record it with `--like` and tell `verify` which selector plays each region:

```sh
motionclone capture http://localhost:5173 --like ref --track ".card" --out mine
motionclone verify ref mine --map card=.card
```

`--like` on a video records your page at the size of the recorded screen.
The viewport is the video frame size divided by `--css-scale`, and the page is drawn at that scale, so your frames have the same pixel size as the video frames.
A 600x1032 crop with `--css-scale 1.5` gives a 400x688 viewport at 1.5x.
If the sizes still differ, `capture` prints a warning.
`--viewport`, `--fps`, `--duration` and `--trigger` still override it.

## Side by side

```sh
motionclone side-by-side ref mine --out compare.gif --labels "Reference,Rebuild"
motionclone side-by-side ref mine-a mine-b --out compare.mp4 --from 0 --to 2000 --crop 0,0,800,600
```

- The first directory is the reference, the others are rebuilds, left to right.
- It works with page captures and video captures.
  Frames of different sizes are scaled to the same height and padded.
- Times line up on t=0 of each capture.
  `--offset "0,120"` moves a capture's clock, in ms, one value per input.
- `--from` and `--to` pick the range in ms, `--fps` the frame rate, `--width` the largest picture width (default 1280).
- `--crop x,y,w,h` cuts every input the same way, or repeat it once per input.
  Use `-` to keep one input whole.
- A `verdict.json` in a rebuild directory adds "PASS 17/17" in green, "FAIL 16/17" in red or "NO CHECKS" in amber under its label.
  The counts hold every checked row, motion and look; the report splits them, such as "motion 4/4, look 12/13".
  Run `verify` first.
- A GIF over 8 MB prints a warning.
  Lower `--width` or `--fps`, cut the range, or write an `.mp4`.
- The MCP tool is `side_by_side`.

## Design sheet

```sh
motionclone sheet ref mine --out design
```

- Writes `design/design-sheet.png`: reference, rebuild and difference at each rest state of the reference and at its last frame.
  These are the same rest states `look.json` measures.
- The difference shows only the pixels that differ, in red on black.
  An empty black panel means the frames match.
- Use it to compare layout, colours and type sizes before you work on motion.
- It works for page and video references.
  The rebuild is scaled to the size of the reference.
- The MCP tool is `design_sheet`.

## What verify writes

- `verdict.json`: every row with its numbers.
- `report.md`: the same as text, with a list of fixes.
- `sheets/`: images for each failing row, with the reference, your version and the difference side by side, and the time of each row.
  The difference shows only differing pixels, in red on black.

Exit codes: 0 when every row passes, 1 when rows fail, 2 when the recordings cannot be compared (different settings, missing files), 3 when nothing was checked.
"NO CHECKS" means no motion or look row was checked, for example when every row is advisory.
It is not a pass.
Track the moving elements, record a longer clip, or add `--fidelity look`.

The report also has these sections:

- **Not measured**: what motionclone could not check for each element, such as colour or shadow.
- **Coverage warnings**: places where the reference changes but no row checks it, for example a part of the page you did not track.
  A result like "PASS with 2 coverage warnings" means the measured motion matches, not that everything does.
- **Partly observed**: rows whose start the reference never shows, for example an element that is invisible while it starts to move.
  Only the visible part is checked.
- **Advisory**: rows with weak evidence.
  They are shown with their numbers but never fail the result.

An element that moves the same way several times, with pauses of at least 250 ms between, gets one row per motion: `.sheet[0].translateY`, `.sheet[0].translateY#2` and so on.
Your version must make the same number of motions; row #2 is checked against your second one.

`spec.json` lists motions it left out under `dropped`, each with a reason.
A fit that starts before the clip, ends after it or runs longer than it is not a row.
Neither is a row that ends where it starts, such as an element the tracker lost for a frame, nor one no curve fits.
Frames where the video tracker lost an element are not readings; a motion seen again after them is its own row.

With `--fidelity look`, verify also checks the design: page and region backgrounds, text and accent colours, type sizes, radii and the position of large blocks, plus a structure score on blurred still frames.
Different words or images are fine; different colours, sizes or layout are not.
From a video, type sizes are cap heights of the text lines, in CSS px: up to three sizes for the screen and for each region.
Your version is measured from its pixels the same way, line by line in the same places.
A line is measured from its letters: icons, dots, rules and struck-through words do not count.
The structure score also has a text score: where the ink of each text line of the reference sits, row by row.
Other words of the same size keep it near 1, and so does another font family of the same size; smaller or moved text lowers it.
The **Look** section names each value that is off and the value to use.
A cap height is read from a line's capitals and digits, the letters that are wide at the top; a line without them uses its x-height divided by 0.71.
A line read from one letter, or from its x-height, takes the cap height of the other lines with the same x-height.
A row of short numbers, such as dates of one or two digits, is one line when its glyphs have one height and sit on one baseline.
A reference line is paired only with a clone line in the same place: the same row of a repeated column, or a line that shares its rows.
When your version has no such line (other words, or no text there), the row is "not comparable": it is listed in the Look section and never fails.
When the reference rests in more than one state, such as light and dark, each state gets its own look rows.
Rows of the last state keep their ids; the others start with the state's name, such as `dark.look.background`, and their label gives the time of the rest frame.
Your version is checked at the frame with the same index.
From a video, look rows also cover the text colour of each region and outside the regions, when one colour holds most of the text.
A large panel (60 % of the screen wide) that stands out from the page gets its top edge (±3 % of the screen) and its corner radius (±20 %).

`progress` rows check how an element's look changes, such as a fade, a dim or a cross-fade.
They are measured from pixels in the element's box, in the reference and in your version the same way.
Their timing must match within one frame plus 20 ms, and their curve is also compared on the same clock.
A change done within two frames is a switch: its row has `steps(1, end)` easing and lasts one frame.
A version that fades instead fails with, for example, "frame[0] progress takes 260 ms, want 18 ms (a near-instant switch)".
`frame[0]` rows measure the whole screen without the boxes of tracked elements that move.
They catch a background that flips behind a sliding sheet: only the pixels that switch colour together are read.
Each change gets its own row: `frame[0].progress`, `frame[0].progress#2` and so on.

`--reduced-clone <dir>` compares your version with a recording of it made with `--reduced-motion`.
The report has a **Reduced motion** section: pass, fail with the properties that still move, or why it could not run.
It does not fail the result.

## Default tolerances

| Check                          | Tolerance             |
| ------------------------------ | --------------------- |
| Start, end, duration           | ±80 ms                |
| Gap between siblings (stagger) | ±40 ms                |
| Easing curve                   | 0.05 of the motion    |
| Distance                       | ±10 %                 |
| Overshoot                      | ±5 percentage points  |
| Colour (look)                  | ΔE 6, background ΔE 3 |
| Size (look)                    | ±8 %                  |
| Block position (look)          | ±3 % of the screen    |
| Panel top edge (look)          | ±3 % of the screen    |
| Panel corner radius (look)     | ±20 %                 |
| Structure (look)               | blurred SSIM 0.9      |
| Text score (look)              | 0.9                   |

## Limits

- From video, motionclone measures position, uniform scale, blur and opacity.
  Rotation is not measured.
  Colour changes are measured as progress rows: fades and switches of a region or of the background.
- When an element is invisible at the start of its motion, its start value and exact easing are a best guess; only the visible part is checked.
- Rows with weak evidence (few clear frames, a loose fit) are advisory and never fail.
- From a video, an opacity row that the pixels contradict drops to medium or low confidence; its notes give both numbers.
- From a video, a small opacity rise (under 15 %) while the same element ends a slide is motion blur clearing, not a fade.
  It goes to `dropped` with that reason.
- A line whose only capital is round (C, S, O) may read its ascenders, about 6 % taller than the capitals.
- When a video region cuts off its element during a move, the row's distance is a lower bound (`distanceObserved: "lower-bound"`).
  A rebuild that moves further passes; the report says so in a note.
- Progress rows only cover changes that mix the frames before and after, like fades and cross-fades.
  A change that moves or scales content gets no progress row.
- From a page, progress rows appear only for changes no other row explains, such as a canvas cover fading inside a tracked card.
- Canvas, WebGL and WebGPU drawing is not measured yet.
- Colour, background, shadow, clip-path and the content inside an element (text, images) are not measured; the report lists them.
- A `steps()` animation that loops cannot be fitted yet.
- Animations started by JavaScript count from when their script ran, about 16 ms before the first frame.
  This does not affect results, because both recordings are made the same way.

## How it works

1. **Capture** opens the page in Chromium with a virtual clock and saves every frame as a lossless image.
   It records each CSS and Web Animations animation from the moment the page opens, and the position, size, opacity, transform and blur of each tracked element on every frame.
2. **Spec** turns that into rows: one per element and property, with start, duration, easing, distance and overshoot.
   It uses the values the page declares when they match what was recorded, and fits a curve otherwise (JavaScript animation, springs, video).
3. **Verify** records your version the same way and checks every row.

Design decisions and their reasons are in [docs/adr](adr).
