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
Tracking runs from the reference end towards the other end with normalised cross-correlation: a coarse search at quarter resolution around a constant-velocity prediction, an integer search at full resolution, then a sub-pixel parabola on each axis.
Normalised cross-correlation ignores affine brightness changes, so an element fading over a flat background still matches at the right place; the regression slope of the frame patch on the template is the opacity proxy (1 at the reference frame).
A frame where the correlation is below 0.5 or the slope below 0.05 counts as not visible: opacity 0, and the position is interpolated between visible frames, or at the clip edges extrapolated one frame with the velocity of the first visible frames and then held.
That one-frame extrapolation assumes an element starts moving when it starts appearing, which is how entrances are built; without it the frame before an entrance holds the first visible position and the fitted curve loses its first 10 to 15 % of progress.
A region name `card[2]` means selector `card`, index 2, so several regions can form one indexed group like DOM items and spec drafting links staggers between them; a plain name is index 0.
The element entry in `track.json` uses that selector and index, the shifted box (`x`, `y`, `w`, `h` in CSS pixels), the opacity proxy and `transform: "none"`; movement shows up as box `x` and `y`, which is also how a DOM capture's bounding box reports a transform.
Proxy values of 0.98 and above count as 1, because the proxy jitters by about 0.03 on h264 at crf 18.
`regions.json` keeps the raw measurements per frame: shift, correlation, opacity proxy, centroid of change against frame 0 and motion energy (mean luma change from the previous frame inside the box).
Automatic regions are connected blobs of 4 px cells whose mean change against frame 0 ever exceeds the noise floor (3 luma levels by default); blobs under 16 cells are dropped, the largest `maxRegions` (8) are kept with a warning when more exist, and they are named `blob[0]`, `blob[1]`... ordered top to bottom, then left to right.

## Limits

- Translation only: scale, rotation and clip-path changes lower the correlation and are not measured; they read as reduced opacity or a lost element.
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
