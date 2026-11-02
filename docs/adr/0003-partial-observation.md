# ADR 0003: partly observed motion

## Status

Accepted, 2026-11-01.

## Context

A video shows only part of some motions.
On the css-blur-scale-in fixture (opacity 0 to 1, `scale: 0.92` to 1 and `blur(12px)` to 0 together, 600 ms, `cubic-bezier(0.22, 1, 0.36, 1)`, starts 150, 250 and 350 ms) recorded at 60 fps with h264 crf 18:
- the first visible frame (opacity 0.125) reads 0 and the second (0.235) reads 0.14 to 0.15;
- the tracker fills scale and blur on frames whose opacity proxy is under 0.2, so their start values are never seen;
- the tail is hidden too: opacity readings from 0.98 snap to 1 and blur under one frame pixel reads 0.

Spec drafting fitted every row on its own, with every filled or snapped frame read as a measurement.
The rows came out 306 to 368 ms long with an `easeOutCirc`-like curve, and verify failed all 9 rows against a DOM clone of the same page.

## Decision: readings as values or bounds

Spec drafting and verify read a track through an observation model (`src/spec/observe.ts`) that turns each frame into a value, a bound or nothing.
Page captures are exact: every frame where the element exists is a value.
Video captures carry the tracker's known limits, measured on this fixture:
- opacity that reads 0 is a bound of 0 to 0.15;
- opacity under 0.3 reads low, so it is a bound from the reading to 0.12 above it;
- opacity that reads 1 is a bound of 0.95 to 1;
- scale and blur on frames whose opacity proxy is under 0.2 are left out, because the tracker filled them in;
- blur that reads 0 is a bound of 0 to one frame pixel in CSS pixels;
- positions stay values, because the tracker's one-frame extrapolation (ADR 0002) already covers entrances that move and fade together;
- when the tracker reports which values it saw (`observed` and `quality` per frame, ADR 0002), unobserved scale, blur and opacity are left out, except an opacity of 0, which stays the bound above because not finding an element is what an invisible element looks like;
- positions the tracker filled in before it first saw the element hold the extrapolated start, so the true start lies there or further from the end value: they are one-sided bounds, and such a row is partly observed.

A row is partly observed when the first frame's reading is not a value, so the start value was never seen.
Such rows are marked `fromObserved: false`; every other row is drafted and verified exactly as before.

## Decision: fitting partly observed rows

A fit residual is the distance from the curve to a reading's bounds, zero inside them, in units of the change the plain readings show.
Residuals beyond 0.03 count linearly (Huber), so one misread frame cannot pull the curve.
The start value is a free parameter, solved in closed form from the plain readings for each candidate timing.
Rows of one element share delay, duration and easing, because CSS and animation libraries usually drive them together.
Tracks whose frames before the motion carry bounds (an opacity that reads 0) set that shared timing; tracks with no readings there (scale and blur while faint) follow it, because with a free start value they fit almost any curve.
A follower that the shared timing leaves more than 0.03 rms worse than a fit of its own gets its own fit, with a note.
Indexed siblings of one selector with the same partial properties (staggered cards) then get one fit with a delay each, kept when it leaves no track more than 0.03 rms worse than its per-element fit.
When more than one track sets the timing, they are weighted by joint evidence: every named curve is first fitted with equal weights, each track's weight becomes one over the square of the best rms any named curve reaches on it (at least 0.005), and the four named curves that score best under those weights are fitted again with them.
So a precise track (a box position) pins the curve and timing that a noisy one (the opacity proxy) cannot tell apart, and the choice does not hang on which track the encoder happened to blur.
Named curves are tried first; a free cubic-bezier replaces the best named one only when its rms, with the tracks' own weights, is closer by 0.005 plus the reading noise (0.03 for video), because noise alone lets a free curve bend towards it.
The row's notes say the start value is extrapolated, from which time the readings start, and which rows share the timing.

## Decision: verifying partly observed rows

For a row with `fromObserved: false`, verify reads the reference track through the same observation model.
It places the clone's own values at the reference's end value, on the same clock, and measures their rms distance to the reference readings and bounds.
It measures the spec curve the same way.
The row passes this `evidence` check when the clone is at most 0.04 further than the spec curve.
Because the times are absolute, the check covers start, stagger, duration, easing and the distance the reference shows.
The start is still compared with the spec start at the usual tolerance.
Duration, end, stagger, easing and distance are not compared with the spec numbers, because the reference does not fix them; the verdict row carries a note that says so, and the report lists these rows under "Partly observed".
Overshoot and direction are checked as usual.

## Decision: plausible fits

A real recording drafted rows no rebuild could match: an opacity easing of `cubic-bezier(0.5777, -2, 0, -2)`, an opacity starting at -0.35, a scale from 0.05 over 98 ms, a blur of 114 px.
Spec drafting now only keeps fits a page could produce:
- opacity readings are clamped to 0..1;
- a fitted start value stays within what the property allows (opacity 0..1, blur from 0, video scale 0.3 to 3, the range the tracker searches); the fit is quadratic in the start value, so clamping its free solution gives the best bounded fit;
- a start value may lie at most the visible change again beyond the visible range; a track whose fit still wants more gets a fit of its own with its start held to the visible range, and the row says so and is low confidence;
- control points keep x in 0..1 and y in 0..1, or -1..2 when the readings go past an end value by more than 2 % (plus the reading noise for video), which covers every back and overshoot curve in use;
- named curves and springs that overshoot more than the readings show, curves that gain more than 0.4 of their progress within 2 % of their time (a step, not an easing) and curves shorter than two frames are not candidates; linear and steps always are.

## Decision: confidence and advisory rows

Confidence was the fit rms alone, so rows built from misread frames still decided the verdict.
It is now the lowest of four levels, recorded with its numbers in the row's `support`:

| Evidence                                                                                             | high              | medium       | otherwise |
| ---------------------------------------------------------------------------------------------------- | ----------------- | ------------ | --------- |
| reliable samples inside the motion: plain readings, not filled in, quality 0.5 or more when reported | 6                 | 3            | low       |
| fit rms, in units of the (visible) change                                                            | 0.005 + noise / 2 | 0.02 + noise | low       |
| share of the change the readings show                                                                | 0.9               | 0.5          | low       |
| mean tracker quality inside the motion, when reported                                                | 0.8               | 0.5          | low       |

The noise is 0 for page captures, so page rows keep the old rms thresholds, and 0.03 for video.
Declared rows of a page capture are high, and a row whose start value was held to the visible range is low.
Verify still compares a low row, but reports it under "Advisory (low confidence)" with its numbers and the reasons the evidence is weak; it never fails the verdict, and the summary reads, for example, "PASS (6 rows checked, 2 advisory)".
Medium and high rows are checked as before.
On every existing fixture and video test no row is low, so every wrong variant still fails where it did.

## Measurements

The fitting method is right when the readings are: the page's exact values put through the same bounds give `easeOutQuint`, 600 ms and the exact starts for all three cards.
The video readings cannot tell fast ease-out curves apart.
With one shared curve and duration, the best named curves score within 6 % of each other: `penner-out-cubic` 394 ms, `easeOutQuint` 566 ms, `material-standard` 478 ms, `easeOutQuart` 478 ms, `material-emphasized` 435 ms, `easeOutExpo` 637 ms.
The true curve at the true starts scores 1.1 to 2.4 times the best per-card loss, because the proxy errs in a pattern: opacity reads 0.04 to 0.05 low and blur 1.3 px low on the third and fourth visible frames, where the tracker trades blur for opacity.
So the drafted rows are `penner-out-cubic`, 394 ms, starting at 168.8, 253.8 and 358.1 ms (page 150, 250 and 350).
The starts are within 19 ms; the duration is 206 ms short and the curve shape differs by up to 0.17 from the declared one.
Over the frames the video shows, the spec curve stays within 0.12, 0.023 and 0.05 of the page's curve for the three cards.
Opacity-only fits per card, or one fit with all three properties weighted equally, did no better (300 to 650 ms, curves from `ease` to `easeOutExpo`).

Against that spec, verify separates clones by a wide margin.
The evidence gap over the spec curve is 0.001 to 0.014 for a DOM clone of the same page and 0.001 to 0.013 for `easeOutQuart` over 500 ms, which the video cannot tell apart from it.
Wrong clones are at least 0.10 worse on the rows they change: `ease-in` 0.49, `linear` 0.35, `ease-out` 0.23, 300 ms instead of 600 ms 0.10, `blur(4px)` 0.12 on blur rows, `scale: 0.8` 0.28 on scale rows, a 150 ms stagger 0.11 on the later cards.
A clone that only fades fails the scale and blur rows of every card, because they do not move at all.

The same libx264 settings give slightly different pixels on Linux and Windows, so these numbers hold for Windows; on Linux the same fixture drafts `easeOutQuint`, 565 ms, starting at 173.3, 255.9 and 364.8 ms, and every check still passes.

On the fade-up stagger video (ADR 0002) each card's opacity and box y both set the timing, and their best named curves are close: on card 2 of the Linux encode, `easeOutQuint` 610 ms and `easeOutExpo` 702 ms differed by 0.3 % of the equally weighted loss.
The opacity proxy (best rms 0.011 to 0.021 of the change) favoured `easeOutQuint` slightly and the box y (0.004 to 0.006) favoured `easeOutExpo` clearly, so equal weights let the encoder pick: card 2 drafted `easeOutQuint`, 280.5 ms, 610 ms (page `easeOutExpo`, 290 ms, 700 ms) on Linux and `easeOutExpo` on Windows.
With joint evidence `easeOutExpo` scores 1.5 to 2.1 on every card of both encodes, against 2.9 or more for the next named curve.

## Alternatives

- Keeping one fit per row with low-visibility frames dropped: scale and blur, with their start unseen, fitted in-out curves with negative delays.
- Widening the duration and easing tolerances to the spread of curves that fit: the true curve scores up to 2.4 times the best, so a spread wide enough to contain it lets wrong easings through.
- Skipping distance for unseen starts: the evidence check covers the distance the reference does show, so a clone that blurs 4 px instead of 12 still fails.

## Limits

- The bounds are measured on h264 crf 18; heavier compression erases more of the faint frames, and the bounds then claim more than the pixels hold.
- A spec drafted from such a video names one of several curves that fit the visible frames equally; its duration and shape are a best guess, and only the evidence check holds a clone to what was seen.
- A clone matched to the spec curve passes by construction; one that matches the page but not the spec curve passes only when it fits the visible readings within the tolerance.
- Followers and siblings share a timing only when it costs each track at most 0.03 rms; motions that start together but use different easings are fitted apart and lose the help of the lead track.
- Spec drafting for a video takes longer: about 7 seconds for the 9 rows of this fixture, most of it in the sibling fit.
- Page captures are partly observed only when an element appears in the middle of its motion; a page element missing for some frames in the middle keeps the usual fit on the frames where it exists.

On the notch-expand fixture (art and title fading in while they scale from 0.7, unblur from 24 px and rise 40 px with overshoot, on a dark panel that grows behind them) the tracker reads the panel, not the art, before the art appears; with its quality fields those frames are left out, every drafted row is plausible and none is low.
A DOM clone of the page passes; a clone without blur and scale fails those rows, and also the box y rows, because a video row y is the top of the scaled box.

## Consequences

- `SpecRow` has `fromObserved` (default true) and `support` (default null); `RowVerdict` has `notes` (default empty) and `advisory` (default null); the verdict summary has `advisory` (default 0); older spec and verdict files still parse, and an older spec's low rows are advisory with a reason that says no evidence was recorded.
- On the fade-up stagger video (ADR 0002), the opacity rows are partly observed, because opacity reads 0 before each card appears; with the tracker's `observed` fields the y rows are partly observed too, share the opacity timing and land on `easeOutExpo` within 5 ms of the declared starts and 16 ms of the 700 ms duration on Linux and Windows, and every existing video check still passes.
- A relative distance is measured against the element's unscaled size, so a rebuild that leaves out a scale no longer fails the translate row of the same element.
