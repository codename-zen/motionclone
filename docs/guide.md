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
That is why motionclone refuses to compare two recordings made with different settings.

## Video and gif

```sh
motionclone probe loader.mov
motionclone capture loader.mov --out ref --start 0:03 --end 0:05 --crop 320,180,960,540 \
  --region "card[0]=40,60,280,160" --region "card[1]=340,60,280,160"
```

- `--region name=x,y,w,h` marks one element to follow, in video pixels after the crop.
  Draw the box around everywhere the element goes during the clip.
  `card[0]` and `card[1]` are measured as a group, like sibling elements on a page.
- Without `--region`, motionclone looks for moving shapes by itself and names them `blob[0]`, `blob[1]` and so on.
- `--css-scale 2` turns a recording of a 2x screen into CSS pixels.
- Pick `--start` after any other content in the same spot has gone, so the region only shows the element you want.

To check your page against the video, record it with `--like` and tell `verify` which selector plays each region:

```sh
motionclone capture http://localhost:5173 --like ref --track ".card" --out mine
motionclone verify ref mine --map card=.card
```

## What verify writes

- `verdict.json`: every row with its numbers.
- `report.md`: the same as text, with a list of fixes.
- `sheets/`: images for each failing row, with the reference, your version and the difference side by side, and the time of each row.

Exit codes: 0 when every row passes, 1 when rows fail, 2 when the recordings cannot be compared (different settings, missing files).

The report also has these sections:

- **Not measured**: what motionclone could not check for each element, such as colour or shadow.
- **Coverage warnings**: places where the reference changes but no row checks it, for example a part of the page you did not track.
  A result like "PASS with 2 coverage warnings" means the measured motion matches, not that everything does.
- **Partly observed**: rows whose start the reference never shows, for example an element that is invisible while it starts to move.
  Only the visible part is checked.
- **Advisory**: rows with weak evidence.
  They are shown with their numbers but never fail the result.

## Default tolerances

| Check                          | Tolerance            |
| ------------------------------ | -------------------- |
| Start, end, duration           | ±80 ms               |
| Gap between siblings (stagger) | ±40 ms               |
| Easing curve                   | 0.05 of the motion   |
| Distance                       | ±10 %                |
| Overshoot                      | ±5 percentage points |

## Limits

- From video, motionclone measures position, uniform scale, blur and opacity.
  Rotation and colour changes in a video are not measured.
- When an element is invisible at the start of its motion, its start value and exact easing are a best guess; only the visible part is checked.
- Rows with weak evidence (few clear frames, a loose fit) are advisory and never fail.
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
