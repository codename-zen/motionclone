---

name: motionclone
description: Recreate, clone or match web motion with numbers instead of eyeballing. Use when the user wants to clone or recreate an animation from a page, "make it move like this", match a hover, scroll, page-load or click effect, or prove that a rebuilt animation matches a reference.
---

# motionclone

Measure a reference animation as numbers, build your own version, and let `motionclone verify` say which element is off and by how much.
The rebuild is the user's own code in the user's own stack.
Never copy assets, fonts, images or source from the reference page.

## Tools

CLI: `motionclone capture | probe | spec | verify | report | sheet | side-by-side` (or `npx motionclone ...`).
MCP: the `capture`, `probe`, `draft_spec`, `verify`, `report`, `design_sheet` and `side_by_side` tools take the same options.
Use whichever is available; the examples show the CLI.

## 1. Scope

Settle these before capturing; ask the user when unclear.

- Target: which element and which motion (load, hover, click, scroll).
- Destination: the project and file where the clone goes, and its stack.
- Fidelity: `motion` or `look`; pick it now, see below.

### Fidelity: motion or look

- `motion`: only the movement must match. The page keeps its own look. This is the default.
- `look`: the rebuild also looks close to the reference: layout, colours, type sizes, radii and spacing.
  The text and images stay the user's own.
- Pick `look` when the user asks for a side by side, says "same" or "similar", says "match the design", or shows the reference next to the result.
- When unsure, ask one short question: "Should it only move the same, or also look close?"
- With `look`, do the design pass below before any motion work.

## 2. Capture the reference

```
motionclone capture <url|path> --out .motionclone/ref --duration 1500 --track ".card, h1"
```

- `--trigger load|hover|leave|click|scroll` with `--target <css>` or `--scroll-to <px|css>`; default is load.
- `--trigger drag --target <css> --drag "0,0@550 0,320@1300"` drags with the mouse during the recording: points are CSS px from the target's centre at ms after the trigger, pressed at the first and released at the last.
- `--track` lists the selectors whose elements are measured every frame; track only what moves.
- Add `--viewport`, `--fps`, `--color-scheme`, `--reduced-motion`, `--storage-state` or `--cdp-url` when the page needs them.
- Read the warnings the command prints (cropped elements, truncated frames, ignored options).

### Reference is a recording (.mp4 .mov .webm .gif)

Use this when the user gives a screen recording or gif and there is no page to open.
Elements are found from pixels, so only translation, uniform scale, blur and opacity are measured.

```
motionclone probe ref.mp4
motionclone capture ref.mp4 --out .motionclone/ref --start 1.2 --end 3 --crop 0,80,1280,640 --css-scale 2   --region "card[0]=40,60,300,200" --region "card[1]=360,60,300,200"
```

- For a screen recording, run `motionclone probe ref.mp4 --screen --sheet .motionclone/probe` first.
  It prints the device screen, a `--crop` and `--css-scale` to use, and the time windows with motion; the sheet is a labelled frame grid of the screen.
- Capture the whole animation the user showed, not only the part that is easy to measure.
  `--start` begins at the rest before the first motion window and `--end` at the rest after the last one; check both on the sheet.
- Keep every moving element whole inside the crop for the whole clip, as far as the recording shows it.
  Never pick a narrower window or crop because the tracker loses an element in part of the clip; capture the whole clip, measure what it can, and tell the user which motions are not measured.
- A crop is trimmed to whole CSS pixels at `--css-scale` (with a warning), so the clone's frames match the reference's size.
- `--css-scale` is video pixels per CSS pixel (2 for a recording of a 2x screen), so distances come out in CSS px.
- `--region name=x,y,w,h` boxes one element, in cropped video pixels; a loose box is fine.
- Name repeated elements `card[0]`, `card[1]`: they become selector `card` with those indexes, and the spec links their stagger.
- Without `--region`, moving blobs are found automatically and named `blob[0]`, `blob[1]`, top to bottom, then left to right.
  A sheet that slides off the screen edge gets one region, and the content it reveals another.
  Declare regions when elements sit closer than about 6 px.
- Colour-only, scale and clip-path changes are not measured.
- For a sliding surface (sheet, drawer, panel), box its whole travel and make sure the box holds content that rides on it (a strip, list rows), not just its plain edge, which can vanish into a same-coloured background.
- Read the warnings; a region that was never found means the box is wrong.
- A warning that a region was lost on some frames means a move in that window was not measured: widen the region over content that moves with the element, or capture that window on its own.

## Design pass (fidelity look only)

Do this before motion work, so the rebuild does not start from your own look.

1. Capture the reference as in step 2. A page or a recording both work.
2. Read the design facts: run `motionclone spec` and read its `look` section, and `look.json` in the capture (palette, text colour, type scale, radii, spacing, blocks).
   Also view the rest frames: `motionclone sheet .motionclone/ref .motionclone/ref --out .motionclone/design` (the reference twice).
3. Build the static layout first, with no motion: sizes, spacing, colours, type sizes, radii.
4. Capture your page with `--like` (step 5), then run `motionclone verify ... --fidelity look` and `motionclone sheet .motionclone/ref .motionclone/clone --out .motionclone/design`.
   The verdict's Look section names each colour, size or block that is off, with the number to use.
   The PNG shows reference, clone and difference at each rest state of the reference (the ones look.json measures) and its last frame.
5. Fix the look rows and the biggest differences, and repeat until the look rows pass and the clone looks close.
6. Only then go on with the motion, from step 3.

Notes:

- A looping reference (several cycles in the clip) must be rebuilt over the whole clip, not one cycle.
  Capture with `--trigger none` and a duration that covers every cycle, and check the later cycles too.
- A sheet compares looks, not motion; mid-motion frames will differ and that is fine.
- When the reference rests in more than one state (light and dark, a panel open and closed), build and check each state, not one static layout.
  The design sheet shows every rest state, and the spec has look rows for each one, such as `dark.look.background`.

## 3. Draft the spec

```
motionclone spec .motionclone/ref
```

One row per element and property: start, duration, easing, overshoot, distance.
`declared` rows come from the page's own CSS or WAAPI animation; `measured` rows are fitted from the track.
Springs list a Motion parameter set and a CSS `linear()` curve.
Rows with `fromObserved: false` come from a recording that hides the start (an element fading in while it scales or blurs): `from` is extrapolated, duration and easing are a best guess, and verify checks the clone against the frames the recording shows.
Elements under "still" must stay still in the clone.

## 4. Build

- Use the project's existing stack. Prefer CSS transitions or animations and WAAPI; then the project's motion library.
- Animate `transform` and `opacity`, not `top`, `left`, `width` or `height`.
- Entrances ease out, not in.
- Wrap the motion in `@media (prefers-reduced-motion: reduce)` or the library's equivalent.
- Copy the spec numbers: start, duration, easing, stagger gaps.
- Use the same selectors the spec tracks, or the rows cannot be matched.

## 5. Capture the clone with --like

```
motionclone capture <cloneUrl> --like .motionclone/ref --out .motionclone/clone
```

`--like` reuses every option of the reference capture except url and out.
Always use it: reference and clone must be captured the same way (viewport, fps, trigger, seed).
Serve the clone from a dev server or a file path; a stale build gives stale numbers.

### Clone against a recording

```
motionclone capture <cloneUrl> --like .motionclone/ref --track ".card" --out .motionclone/clone
motionclone verify .motionclone/ref .motionclone/clone --map "card=.card"
```

- `--like` on a recording copies its fps and clip length and uses the load trigger; `--track` is required, and the url is the clone page.
- It also sizes the clone like the recorded screen: the viewport is the reference frame size divided by `--css-scale`, and the device scale factor is the css scale, so clone frames have the same pixel size as the video frames; a warning says when they still differ.
  Do not add `--viewport` unless the clone must differ.
- Only fps must match the recording; viewport, trigger and seed are not compared.
- `--map refName=cloneSelector` renames the clone's tracks to the region names, repeatable; `card=.card` maps every index, `card[2]=.x[0]` one element.
- Rows compare change, timing and easing, not absolute positions.
- A translateY in the clone moves the box y too, so video position rows are compared with the clone's box x and y, in CSS px.
- Pixel fidelity is not available against a recording.

## 6. Verify

```
motionclone verify .motionclone/ref .motionclone/clone
```

The first argument is the reference capture directory or its `spec.json`.
It writes `verdict.json`, `report.md` and, for failing rows only, `sheets/<row>.png`.

Exit codes: 0 all rows pass, 1 rows fail, 2 setup error or bad input, 3 no checks (nothing was compared; not a pass).
On exit 2, read the message: a mismatch in viewport, trigger or fps means the clone was not captured with `--like`.

## 7. Fix and repeat

Each failing row has one sentence naming the element, the number and the direction:

- "starts 120 ms late (want 200, got 320)": change the delay.
- "runs 150 ms too short": change the duration.
- "easing too slow at the start ... the clone fits ease-in": change the curve to the spec's.
- "overshoots 0 % (want 12 %)": use a spring or a bezier with overshoot.
- "moves 40 px (want 80 px)": fix the distance.
- "does not move": the property is not animating, or a layout property moves instead.
- "is missing in the clone": the selector matches nothing.

Fix the rows the verdict names, nothing else, then capture the clone again and verify.
Open a sheet only for a failing row; it shows reference, clone and diff.
Do not view frames of passing rows.

Stop after 5 rounds.
Report the residual rows to the user with their messages and your guess at why, instead of widening tolerances or hiding them.

## 8. Show the result

End every run the user wants to show with a side by side:

```
motionclone side-by-side .motionclone/ref .motionclone/clone --out .motionclone/side-by-side.gif --labels "Reference,Rebuild"
```

- Run `verify` first. A `verdict.json` in the clone directory adds its result under the label, for example "PASS 4/4" in green or "FAIL 1/4" in red.
- Several clone directories compare several rebuilds. Use `.mp4` for long clips. A gif over 8 MB gets a warning; lower `--width` or `--fps`, or use `--from` and `--to`.
- `--crop x,y,w,h` (once for all, or once per input) cuts away unrelated page area.
- `--offset "0,120"` shifts a capture's clock when its motion starts late or early.
- Show the same span the user showed: the reference and the rebuild cover the whole animation, from rest to rest.
  Look at a first, middle and last frame of the output; if an element is cut off at an edge or the clip ends mid-motion, capture again with a wider window or crop.
- Do not hand-roll ffmpeg for this.

## Notes

- JavaScript timelines (GSAP, Motion, timers) start about 16 ms before t=0, so a spec row measured from one can sit 16 ms off a CSS rebuild; the default tolerance covers it.
- Pixel diff runs on rest frames only, and only fails the verdict with `--fidelity pixel`.
- Pass `--reduced-clone <dir>` (a clone capture taken with `--reduced-motion`) to check the reduced-motion guardrail.
- Guardrail warnings (layout properties, ease-in entrances, no reduced-motion) do not fail rows; fix them anyway.
