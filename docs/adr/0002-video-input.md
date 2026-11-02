# ADR 0002: video and gif input

## Status

Accepted, 2026-10-31.

## Context

A screen recording or gif has no DOM, no declared animations and no virtual clock.
The rest of the pipeline (measure, fit, spec drafting, verify) reads a capture directory: `frames/`, `track.json`, `animations.json` and `capture.json`.
Video input must produce that same directory, with frame times as trustworthy as a DOM capture and element tracks measured from pixels alone.

## Decision: frame timing

Output frame k is the source frame on screen at `start + k / fps`, where times count from the first decoded frame.
We do not rely on ffmpeg's `fps` filter or `-ss` seeking to choose frames, because both decide with rounding rules that depend on the container and drop the frame shown at `start` when its timestamp is slightly earlier.
Instead ffmpeg decodes the first video stream once through `showinfo` with `-fps_mode passthrough`, which lists every frame's decoder number and timestamp.
For each k we pick, in our own code, the last source frame whose timestamp is at or before `start + k / fps`, plus half a timestamp tick of slack (at least 0.5 ms).
The slack absorbs containers that round times: gif delays are whole centiseconds, so a 30 fps gif alternates 3 and 4 cs delays and frame k sits up to 3.3 ms off k / 30.
A second ffmpeg pass decodes only the needed range with `select=between(n,first,last)`, crops and scales, and writes each source frame once as a lossless RGB PNG with `-fps_mode passthrough`; we then rename or copy them to `frames/0000.png...`.
Source frames reused for several output frames (output fps above source fps, or held gif frames) are copied, never re-encoded.
The default rate is the source rate capped at 60 fps; for gifs the source rate is measured from the frame timestamps, not the header, and snapped to a whole number when within 1 %.
`track.json` uses the same whole-millisecond grid as DOM captures (`round(k * 1000 / fps)`), and the trigger is `none`, so t=0 is the first extracted frame.
`capture.json` keeps the CaptureFile fields that spec drafting and verify read, marks `source: "video"` and `stack: ["video"]`, and adds a `video` section with the probe, start, end, crop, scale, `cssScale` and the source frame used for each output frame.
Sizes are reported in CSS pixels: a frame pixel is `1 / (scale * cssScale)` CSS pixels, where `cssScale` is source pixels per CSS pixel (2 for a recording of a 2x screen).
The lossless round trip is tested: a PNG-in-mov encode of a capture extracts back to byte-identical frames on a 30 fps grid starting at 250 ms.

## Decision: pixel tracking

Each region is one element, given in source pixels after the crop, or found automatically.
The work happens on luma (Rec. 601) after a 3x3 box blur, which removes most compression noise and gif dithering.
A region is first tightened to the content that differs between the first and last frame, so a loose box around a card shrinks to the card.
The reference frame is the end of the clip (first or last) that shows more structure inside the region: the last frame for an entrance, the first for an exit or a move.
The template is the element box at the reference frame plus a 6 px ring of surroundings, so a flat-coloured element still has edges to match.
Tracking runs from the reference end towards the other end with normalised cross-correlation against a model of the element at a pose: centre, uniform scale and blur (next section).
Normalised cross-correlation ignores affine brightness changes, so an element fading over a flat background still matches at the right place; the regression slope of the frame patch on the model is the opacity proxy (1 at the reference frame).
A frame where the match fails the quality check in the next section counts as not visible: opacity 0, and the position is interpolated between visible frames, or at the clip edges extrapolated one frame with the velocity of the first visible frames and then held.
That one-frame extrapolation assumes an element starts moving when it starts appearing, which is how entrances are built; without it the frame before an entrance holds the first visible position and the fitted curve loses its first 10 to 15 % of progress.
A region name `card[2]` means selector `card`, index 2, so several regions can form one indexed group like DOM items and spec drafting links staggers between them; a plain name is index 0.
The element entry in `track.json` uses that selector and index, the box moved and scaled about its centre (`x`, `y`, `w`, `h` in CSS pixels: the top-left and size of the scaled box, like a DOM bounding box under a transform), the opacity proxy, `transform` and `filter`.
Movement shows up as box `x` and `y` only, which is also how a DOM capture's bounding box reports a transform.
Scale is written as `transform: "matrix(s, 0, 0, s, 0, 0)"` to four decimals, relative to the element's size in the reference frame, and as `none` when it is exactly 1.
It is not snapped near 1 frame by frame, because that cut the slow tail of an ease-out short; elements that do not scale get exactly 1 from the second pass below.
Blur is written as `filter: "blur(Npx)"` in CSS pixels of the element's own space, and as `none` under one reference-frame pixel.
Proxy values of 0.98 and above count as 1, because the proxy jitters by about 0.03 on h264 at crf 18.
`regions.json` keeps the raw measurements per frame: shift of the box centre, scale, blur (reference-frame pixels), correlation, opacity proxy, `quality`, `status`, centroid of change against frame 0 and motion energy (mean luma change from the previous frame inside the box).
Automatic regions are connected blobs of 4 px cells whose mean change against frame 0 ever exceeds the noise floor (3 luma levels by default); blobs under 16 cells are dropped, the largest `maxRegions` (8) are kept with a warning when more exist, and they are named `blob[0]`, `blob[1]`... ordered top to bottom, then left to right.

## Decision: scale and blur

A screen recording of an expanding panel showed that translation alone loses an element that also scales and blurs in: half the frames were not found, and scale and blur were never measured.
The model is the reference template blurred by a Gaussian of sigma `b` in its own pixels and then scaled by `s` about the window centre, so the frame shows a blur of `s * b`.
That is how CSS applies a filter, in the element's own space before its transform, so `b` is the CSS `blur()` value: an element at `scale(0.5)` with `blur(16px)` measures 16, not 8.
Rendering samples a blurred copy of the reference frame around the window (bilinear, edges repeated); shrinking adds the variance of the averaged pixels, `(1 / s^2 - 1) / 12`, so a smaller copy is not sharper than the browser would draw it.
Blurs up to 4 pixels use an exact kernel and larger ones three box passes of about the same variance; blurred sources are cached in 2 % sigma steps, so neighbouring frames share them.
The template is placed at the pose's sub-pixel offset, so scale and blur never absorb a half-pixel misalignment; before this, a translating card showed 1 % scale wiggles and 0.5 px blur.
Each frame is searched near a constant-velocity prediction of all four values (scale in log space):
- a shift search at quarter resolution (10 pixels, 40 frame pixels);
- scales in 6 % steps (two each way), then blurs from a ladder of 0, 1, 2, 3, 4.5, 6.5, 9, 13, 18, 25 and 35 reference pixels (two rungs each way), twice, each with a 3x3 shift search;
- at full resolution, or half for templates over 40,000 pixels, a sub-pixel shift, then scale in 2 % steps and blur in steps of 15 % (at least 0.5 px), each walked to a peak and finished with a parabola;
- a last sub-pixel shift at full resolution.

Scale is kept between 0.3 and 3.
Scale and blur stay near the prediction instead of a free search over the whole range: a free search on frames where the element is invisible let a tiny, heavily blurred model lock onto nearby heading text and drift.
The cost is that an element which reappears after a gap at a very different scale or blur is not found again.
A frame whose opacity proxy is under 0.2 gives its position but not its shape, so it is placed with the scale and blur of the last clear frame, and its scale and blur are later filled from clear frames like a lost position.
Blur is searched up to 35 reference pixels, the top of the ladder; the prediction is clamped to the same scale and blur ranges.
A region whose scale stays within 1 % of 1, or whose blur stays under one pixel, in every clear frame, is tracked a second time with that value fixed, because jitter in a free parameter leaks into the position: a translating card read 0.3 % scale jitter as a 0.3 px sideways move.
The opacity proxy is the slope against the blurred, scaled model, so blur and scale do not read as fading; on a blur-only element it stays at 0.97 or above.
On a synthetic page captured at 60 fps and encoded with h264 crf 18, with three 200x130 elements:
- `scale(0.5)` to `scale(1)` over 600 ms, `cubic-bezier(0.22, 1, 0.36, 1)`: scale within 0.01 of the DOM at every frame, start on the same frame, fitted curve within 0.003 of the declared one, every transition frame found;
- `blur(16px)` to `blur(0)`: 15.0 to 15.3 at the start, within 1 px of the DOM through the move, 0 at rest, every transition frame found;
- both with a `translateY(80px)`: the same numbers.

A 600x360 panel growing from `scale(0.5)` with `blur(20px)` on a 1200x520 recording tracks 91 frames in about 3 seconds, plus half a second of extraction.

## Decision: match quality

A screen recording of a dark notch expanding into a media player showed the tracker reporting confident nonsense: scale 0.054, blur 114 px and opacity readings that later fitted to negative values, all marked found.
The notch-expand fixture reproduces it: a barely visible panel edge sweeps through the regions, compact content blurs out above them, and the expanded art and title then fade, scale and unblur in from `blur(24px)`.
The old rule (correlation 0.5, slope 0.05 to 2) found the art on frames 0 to 21, at scale 0.31 on the compact thumbnail outside its region, and at blur 81 px on the panel edge; the title matched the panel edge at scale 1.3 and blur 25.
A blurred model is smooth, so it correlates 0.6 to 0.8 with any smooth edge, and a small copy of a gradient tile correlates 0.995 with a similar thumbnail.

Each match is now judged against the noise `n`.
`n` is the larger of a third of `noiseFloor` (the per-pixel change threshold, taken as three standard deviations; 1 luma level by default) and the luma noise between the quietest pair of the four frames at the reference end, inside the template window.
With `p` the luma standard deviation of the patch under the model and `r` the correlation, the model explains an amplitude `a = r * p`.
The fidelity is the share of the patch's structure above noise that the model explains: `a^2 / (a^2 + max(0, p^2 - a^2 - n^2))`.
On a faint element the residual is mostly noise, so fidelity stays near 1 even at a correlation of 0.83; on other content the residual is structure, so fidelity drops.
A frame's status is one of:
- `found`: correlation at least 0.5, slope 0.05 to 1.25, fidelity at least 0.9, slope at least 0.2 and `a` at least `n`; position, scale and blur are measured;
- `faint`: as found, but the slope is under 0.2 or `a` under `n`; only the position is measured, scale and blur are filled;
- `other`: the slope is above 1.25 or the fidelity under 0.9, while the patch spread is at least 3 `n`: the region shows something that is not this element;
- `absent`: nothing above the noise.

The slope bound was 2; visible elements read at most 1.03 on every existing fixture, so 1.25 still leaves room for h264 jitter, and more means the frame holds more structure than the element at full opacity.
The fidelity threshold is calibrated on the fixtures at crf 18 with the default noise floor: every frame found by the old rule on the earlier fixtures scores 0.994 or more, the faintest true frames of notch-expand 0.95 and more, and the false matches 0.20 to 0.72 (0.88 for one frame on the way to the thumbnail).
A frame the search does not find is judged again at the expected place (the prediction with the last clear scale and blur), because the search may have strayed up to 40 pixels onto nearby content; `other` therefore means the element's own place is busy, not some neighbour.
A frame that is not found does not move the pose or the velocity, so a false match can no longer start a chain that walks the template off its region.
`quality` is the fidelity times `min(1, a / 4n)`, so a match at the noise floor reads low even when it fits; the opacity proxy is clamped to 0..1.

Each element in a video `track.json` carries:
- `quality`, 0..1, as above, rounded to two decimals;
- `observed: { position, scale, blur, opacity }`, which values were measured on this frame: `position` on found and faint frames, `scale` and `blur` on found frames, `opacity` on every frame except `other`.
  Values that are not observed are still written, so the existing fields stay valid: positions follow the fill rule above (which ADR 0003 keeps as values for entrances), scale and blur are filled from the nearest found frames and held, and opacity is 0.
  Readers should treat unobserved scale and blur as unknown, never as readings; page captures omit both fields, because every value there is exact.

On notch-expand, captured at 60 fps and encoded at crf 18, with regions around the start and end boxes of the art and title plus 12 px:
- no frame before 450 ms is found; the art reads `absent` on frames 0 to 20 and 25 to 28 and `other` on 21 to 24 while the panel edge crosses it, the title `other` on 21 and 22;
- the first found frame is 29 for the art and 31 for the title, where the page opacity crosses 0.2 at frames 29.4 and 31.2;
- once the proxy reads 0.3, scale is within 0.005 of the page and blur within 0.8 px, opacity within 0.031; at rest scale is 1 and blur 0;
- no frame reports a scale under 0.81 or a blur over 12.1 px (filled values included);
- tracking takes 2.5 s for 73 frames and two regions, against 2.0 s before.
  On the fade-up stagger and blur-scale-in fixtures every frame found before is still found, and `track.json` values are unchanged.

## Limits

- Uniform scale and Gaussian blur only: rotation, non-uniform scale, perspective and clip-path changes lower the correlation and are not measured; they read as reduced opacity or a lost element.
- Scale changes under about 1 % are treated as noise and blurs under one frame pixel as none, so the last frames of a blur that eases out read as 0 a little early.
- The box is the tightened region scaled about its centre, so when the region holds background around the element (a blurred start spreads the changed area), the reported box is larger than the element; scale itself is unaffected.
- The blur model assumes the element sits on a flat background: blurring the template also blurs whatever surrounds it in the reference frame, so busy surroundings bias blur.
- Blur and fading both lower edge contrast; the model separates them by shape, but on a faint element (proxy under 0.2) neither scale nor blur is measured, and a blur measured while the element also fades can trade a little blur for opacity.
- The quality thresholds are calibrated on h264 crf 18 with the default noise floor; heavier compression needs a higher `noiseFloor`, or true faint frames read as `other`.
- An element whose region already holds a similar object at the expected place (a thumbnail swapped for the same artwork) still matches it; the check only rejects content the model does not explain.
- An element that reappears after a gap far from its last clear pose is not found again, because a lost frame does not move the search.
- Blur is measured up to about 35 reference pixels; at 16 to 20 px the estimate reads 4 to 6 % low.
- An element that fades in from opacity 0 while it scales and unblurs shows its start values only after it becomes visible, and h264 hides the faintest frames.
  On the css-blur-scale-in fixture (opacity, `scale: 0.92` and `blur(12px)` in over 600 ms, `cubic-bezier(0.22, 1, 0.36, 1)`) at crf 18, the first frame with opacity 0.125 reads a contrast of 0.02 (0.125 on the lossless frames), so the video starts at blur 10.1 and scale 0.92 for the first card, and 6.8 px and 0.945 for the second.
  Once a card's opacity passes 0.3, opacity is within 0.065 of the DOM, scale within 0.009 and blur within 1.5 px.
  The fitted rows still come out about 320 ms long instead of 600 ms, with an `easeOutCirc`-like curve: this ease-out puts a quarter of its change into the first two frames, and the exact DOM series with only its first visible frame zeroed fits the same 364 ms `easeOutCirc`.
  Even a lossless encode fits 370 to 420 ms, because small opacity proxy deviations (up to 0.05 mid-move) are enough to change the fit.
  So verifying such a video against a DOM clone fails on duration and distance; it is a limit of what the pixels hold plus the fit's sensitivity, not of tracking.
  ADR 0003 covers how spec drafting and verify now handle such partly observed rows.
- Colour-only changes are invisible to the tracker, because it works on luma and ignores brightness scaling.
- Overlapping elements: when another moving element enters the template area, the match follows whichever dominates; declare tighter regions or crop.
- Automatic blobs merge elements closer than about one cell plus the blur (about 6 px); declare regions in that case.
- An element is unobservable while fully transparent; the extrapolation above covers entrances that move and fade together, not ones that move a long way before appearing.
- Compression noise sets the floor: on h264 crf 18 the position jitters by about 0.1 px and the opacity proxy by about 0.03; heavier compression needs a higher `noiseFloor`.
- Gif palettes and dithering add noise, and centisecond delays quantise timing to 10 ms.
- Variable frame rate recordings are handled by the timestamp rule above, but the default fps comes from the header average.
- A full-frame decode is done once to read timestamps, so cost grows with the position of `start` in long recordings.
- Verify can compare a video reference with a DOM clone: `--map card=.card` renames the clone's track keys to the region names (`card[2]=.x[0]` maps one element).
  Only fps must match, so the clone is captured with `--like <videoCaptureDir>`, which takes fps, duration and a load trigger from the video; viewport, trigger and seed are not compared against a video.
  Rows compare change, timing and easing, never absolute offsets.
  Distances are CSS pixels on both sides: the video side is scaled by `cssScale`, and a DOM `translateY` moves the box y too, so video box rows are compared with the clone's box x and y.
  Relative distances are not used against a video, because the region box and the element box differ in size.
  Pixel fidelity needs two DOM captures and is a setup error against a video.

## Consequences

- Spec drafting and verify run unchanged on video captures; every row is `measured`, with no declared animations.
- On the css-fade-up-stagger fixture recorded to mp4 at 60 fps, card starts land within 4 ms of the answer key and the easing within 0.035 of it.
- Fixing this exposed a divide-by-zero in `normalise` for there-and-back moves that end exactly where they started; they are now scaled by their peak.
