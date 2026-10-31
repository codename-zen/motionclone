---

name: motionclone
description: Recreate, clone or match web motion with numbers instead of eyeballing. Use when the user wants to clone or recreate an animation from a page, "make it move like this", match a hover, scroll, page-load or click effect, or prove that a rebuilt animation matches a reference.
---

# motionclone

Measure a reference animation as numbers, build your own version, and let `motionclone verify` say which element is off and by how much.
The rebuild is the user's own code in the user's own stack.
Never copy assets, fonts, images or source from the reference page.

## Tools

CLI: `motionclone capture | probe | spec | verify | report` (or `npx motionclone ...`).
MCP: the `capture`, `probe`, `draft_spec`, `verify` and `report` tools take the same options.
Use whichever is available; the examples show the CLI.

## 1. Scope

Settle these before capturing; ask the user when unclear.

- Target: which element and which motion (load, hover, click, scroll).
- Destination: the project and file where the clone goes, and its stack.
- Fidelity: `motion` (default, timing, easing, distance) or `pixel` (also compares rest frames).

## 2. Capture the reference

```
motionclone capture <url|path> --out .motionclone/ref --duration 1500 --track ".card, h1"
```

- `--trigger load|hover|leave|click|scroll` with `--target <css>` or `--scroll-to <px|css>`; default is load.
- `--track` lists the selectors whose elements are measured every frame; track only what moves.
- Add `--viewport`, `--fps`, `--color-scheme`, `--reduced-motion`, `--storage-state` or `--cdp-url` when the page needs them.
- Read the warnings the command prints (cropped elements, truncated frames, ignored options).

### Reference is a recording (.mp4 .mov .webm .gif)

Use this when the user gives a screen recording or gif and there is no page to open.
Elements are found from pixels, so only translation and opacity are measured.

```
motionclone probe ref.mp4
motionclone capture ref.mp4 --out .motionclone/ref --start 1.2 --end 3 --crop 0,80,1280,640 --css-scale 2   --region "card[0]=40,60,300,200" --region "card[1]=360,60,300,200"
```

- `probe` prints size, frame rate, duration and codec; check them before choosing anything.
- Pick `--start`, `--end` and `--crop` from a few frames: capture a short range to a scratch directory, open frames/0000.png and a late frame, then cut dead time and unrelated UI.
- `--css-scale` is video pixels per CSS pixel (2 for a recording of a 2x screen), so distances come out in CSS px.
- `--region name=x,y,w,h` boxes one element, in cropped video pixels; a loose box is fine.
- Name repeated elements `card[0]`, `card[1]`: they become selector `card` with those indexes, and the spec links their stagger.
- Without `--region`, moving blobs are found automatically and named `blob[0]`, `blob[1]`, top to bottom, then left to right.
  Declare regions when elements sit closer than about 6 px.
- Colour-only, scale and clip-path changes are not measured.
- Read the warnings; a region that was never found means the box is wrong.

## 3. Draft the spec

```
motionclone spec .motionclone/ref
```

One row per element and property: start, duration, easing, overshoot, distance.
`declared` rows come from the page's own CSS or WAAPI animation; `measured` rows are fitted from the track.
Springs list a Motion parameter set and a CSS `linear()` curve.
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

Exit codes: 0 all rows pass, 1 rows fail, 2 setup error or bad input.
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

## Notes

- JavaScript timelines (GSAP, Motion, timers) start about 16 ms before t=0, so a spec row measured from one can sit 16 ms off a CSS rebuild; the default tolerance covers it.
- Pixel diff runs on rest frames only, and only fails the verdict with `--fidelity pixel`.
- Pass `--reduced-clone <dir>` (a clone capture taken with `--reduced-motion`) to check the reduced-motion guardrail.
- Guardrail warnings (layout properties, ease-in entrances, no reduced-motion) do not fail rows; fix them anyway.
