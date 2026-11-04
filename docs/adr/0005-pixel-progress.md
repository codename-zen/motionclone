# ADR 0005: appearance progress from pixels

## Status

Accepted, 2026-11-03.

## Context

A phone recording of a card that expands while a backdrop dims, after which a cover cross-fades away to show a prize, was measured two ways.
The tracker read the dimming header's opacity through its contrast proxy as 675 ms over 339 ms, with confidence high.
A plain pixel method read the dim as 650 ms over 272 ms, `ease`, with rms 0.023 against its readings; the tracker's curve fits the same readings with rms 0.070.
A rebuild made from the tracker row was 25 ms and 67 ms off, so a row the verdict trusted was confidently wrong.
The cross-fade is not the opacity of any tracked element at all, so the tracker had no row that could describe it.

## Decision: the method

Progress of a region at frame t is 1 - dist(frame t, end) / dist(start, end), where dist is the mean absolute RGB difference over the region (`src/pixel/`).
For a fade, a dim or a cross-fade every pixel is a mix of the start and end frames, so this progress is the mix weight, whatever the colours.
The region is the union of an element's boxes over the whole capture, in CSS px.
It is placed in frame pixels by removing the capture's clip offset and scaling by the frame width over the clip width, so device scale and crops work for page and video captures alike.
Large regions are sampled on a grid of at most 40000 pixels per frame.
The activity curve is the same mean difference between consecutive frames.
A frame is at rest when it changes by at most 0.5 levels, or three times the quietest quarter of the capture when the encoder is noisier.
A change runs between the last rest frame before it and the first rest frame after it; rest gaps up to 50 ms (at least two frames) inside it are slow moments, not its end.
A quiet frame on either side that still moves the region at least 2 % of the way from start to end (the least-squares projection of its step onto the change) belongs to the change.
A short fade that ends just after a frame moves only a few % on the next one, often under the rest limit: taken as rest, the frame before it became the end, the true rest read a few % off it, and the fit took that for a spring settle.
Each change also gets a blend residual: the largest share of the change, on any frame inside it, that a mix of its two rest frames leaves unexplained.

## Decision: progress rows

Only changes with a blend residual of at most 0.05 and a distance of at least 2 levels become rows.
Fades measure 0.003 to 0.010 here, on page and h264 crf 18 frames; a card that moves and scales measures 0.39 to 0.45, and a region where a dim and that card overlap 0.11.
A row's property is `progress`, from 0 to 1, fitted with the same fit as every measured row, with confidence from its sample count and fit rms (ADR 0003, with the video noise for video).
Its id is `<element>.progress`, and `<element>.progress#2` for an element's second change.
Its start, end and duration tolerances are one frame plus 20 ms, the margin the cross-check below uses for the same change, because pixels place a change within a frame.
From a video, every such change of a region gets a row.
From a page, rows already measure most changes exactly, so a change gets a row only when rows of elements over the same region run on less than 90 % of its frames, such as a canvas cover that cross-fades inside a tracked card.
A change seen at the same time in an element and in a smaller element inside it belongs to the smaller one.

## Decision: the cross-check

When an opacity row and a progress row of the same element overlap by at least half of the shorter one, their timed curves are compared.
They disagree when their starts differ by more than one frame plus 20 ms, or their curves on the same clock differ by more than 0.05 anywhere.
A disagreeing opacity row drops to medium at most.
It drops to low when its curve sits at least twice as far from the pixel readings as the progress curve does, and at least 0.02 further (rms).
Rows of the same element that share its exact start and duration, such as a blur fitted on its timing (ADR 0003), drop with it.
The note names both measurements: start, duration, easing, the start and curve gaps and both rms values.
An agreeing medium row becomes high; an agreeing row gets a note too.

## Decision: verify

A progress row is checked by measuring the clone's frames with the same method, in the box of the element the row names, after `--map` renaming.
For a DOM clone of a video reference that is the mapped element's box from the clone track; for a page reference it is the same element's box.
The clone's change that overlaps the row most is used, or the nearest one.
Its start and duration come from a fit with the row's easing held fixed (ADR 0004), and the row is checked like any other, with the tighter timing tolerances above.
It is also checked on the same clock: the largest gap between the clone's readings and the spec curve may be at most the easing tolerance plus the row's easing residual.
Errors in start, duration and shape that each stay inside their own tolerance add up there; a timing failure already explains the gap, so then only the timing message is shown.
A video opacity row is the tracker's reading of pixels; when the mapped clone element's CSS opacity does not change, its appearance in that element's box is measured with this method instead, and the verdict row says so.
So a clone that dims a header with an overlay passes the header's opacity row from the video.

## Decision: switches and the background

A looping phone recording flips the whole screen from light to dark in about one frame while a white sheet slides down, and back.
The rebuild faded through grey over 260 ms, and verify only gave coverage warnings: no row described the flip.
A change done within two frames is a switch: no frame shows its shape, so it is not fitted.
Its row runs from the last rest frame before it to the first one after it (one frame), with `steps(1, end)` easing, and high confidence when at least six rest frames bracket it.
Verify reads a clone's switch the same way and any other change with a free fit.
A switch row skips the easing and curve checks, because its duration already tells a switch from a fade.
A clone that fades fails with "frame[0] progress takes 239 ms, want 18 ms (a near-instant switch)".

The frame is a region too: `frame[0]`, the captured area without the boxes of tracked elements that move.
A background change behind moving content is not a mix of its two rest frames.
So in the frame each change is read from the pixels that switch together: pixels near the most common colour of the changed pixels at both rests, which cross half way on the most common frame.
Their own changes become `frame[0].progress`, `frame[0].progress#2` and so on, one per change, with the usual blend and distance limits, when they cover at least 5 % of the region.
Verify places the reference's frame region on the clone's captured area and measures the clone there, page or video.
A change the frame shares with a smaller region inside it, outside the left-out boxes, belongs to that region.

## Measurements

On expand-dim-reveal (57 fps, 816x1080):

| Change             | Declared             | Page capture          | Video, h264 crf 18    |
| ------------------ | -------------------- | --------------------- | --------------------- |
| cover cross-fade   | 1500 ms, 260, linear | 1500.3, 259.4, linear | 1500.2, 259.5, linear |
| dim, header region | 650 ms, 272, ease    | 649.4, 273.7, ease    | 649.0, 275.1, ease    |

Fit rms is 0.0009 to 0.0020 of the change.
A page capture that tracks the card, the dim and the cover drafts no progress row; one that tracks only the card and the dim drafts `.card[0].progress` for the cross-fade.
On the video the tracker read the header dim at 650.1 ms over 274.8 ms, `ease`: the curve gap is 0.009 and the row stays high.
The committed tracker read the card's cross-fade as an opacity at 1503.4 ms over 317.5 ms, `ease-out`: the curve gap is 0.069 and the rms against the pixels 0.043 against 0.001, so it and the blur row sharing its timing drop to low.
A clone that dims for 339 ms with `material-emphasized` from 650 ms passed every timing check: refitted with `ease` it starts at 640.1 ms and runs 285.7 ms, with a shape gap of 0.054 against a tolerance of 0.056.
On the same clock it is 0.09 off the spec curve at 719 ms, and fails.
A clone whose cross-fade starts 120 ms late fails with "card[0] progress starts 120 ms late (want 1500, got 1621)".
A clone of the same page passes every row, the header's opacity row included, measured from the clone's pixels.

On `fixtures/_variants/sheet-flip` (600x1032, 56 fps, flips at 400 and 1700 ms while the sheet slides 440 px over 300 ms), recorded as h264 crf 18 with a region around the sheet:
- the tracker followed a 280 px wide part of the sheet, so the frame region still held the rest of the slide: the whole frame read 393 to 643 ms with a blend residual of 0.50;
- the pixels that switch together read 393 to 411 ms, blend 0.000, for both flips, on the video and on the page;
- a page clone of the same page passes; one that fades over 260 ms measures 239 and 238 ms and fails both rows.

## Alternatives

- The least-squares projection of each frame onto the line from start to end is not biased by encoder noise; the distance ratio was kept because it is the method the recording was measured with, and its fits stay within 0.002 rms here.
- Progress rows for every change, moving content included: the progress of a moving card depends on the region drawn around it, and a video region and a page element box differ, so the same motion would fail.
- Leaving the cross-check out and letting both rows count: the tracker row then still fails a correct rebuild, or passes a wrong one, with confidence high.

## Limits

- Two fades that overlap in time inside one region are not a single mix and get no row.
- A frame region needs at least 2 % of the screen outside the boxes of moving elements; a background change seen only behind them gets no row.
- Changes that move or scale content get no progress row; the tracker rows cover those.
- An outer element loses a change that a smaller element inside it shows at the same time, even when the outer one also changes elsewhere.
- Drafting reads every frame once: about 1 to 2 seconds more per spec on these captures.

## Consequences

- `SpecRow.property` accepts `progress`; older spec files still parse.
- The verdict of a progress row has a `curve` metric.
- `CloneMotion` keeps only the series and window of the clone's motion, so motions read from pixels fit in it.
- Progress rows of the `frame` pseudo element need no tracked element in the clone, and a `steps(1, end)` progress row is a switch.
