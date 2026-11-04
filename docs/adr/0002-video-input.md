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
A clip that ends in the state it starts in is planned from its rest plateaus instead (see rest plateaus below).
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
Automatic regions are connected blobs of 4 px cells whose mean change against frame 0, or against the rest plateau before it (see rest plateaus below), ever exceeds the noise floor (3 luma levels by default); blobs under 16 cells are dropped, the largest `maxRegions` (8) are kept with a warning when more exist, and they are named `blob[0]`, `blob[1]`... ordered top to bottom, then left to right.

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
The cost is that an element which reappears after a gap at a very different scale or blur is not found by this search; the wide search in the next sections finds it again.
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

## Decision: re-acquisition, both ends and colour

A phone recording of a reward card that grows from a grid to the centre (scale 0.62 to 1 in about 310 ms while it moves, then a dimming backdrop and a cross-fade) lost the card on its first growing frame and never found it again.
The per-frame scale change (about 3 % at 57 fps) and the darkening background around the card pushed the match below the quality gate, a lost frame did not move the search, and the region was never tightened because the dim changed every pixel in it.
The expand-dim-reveal fixture reproduces it.

Re-acquisition: when neither the prediction nor the expected place passes the quality gate, and the patch is `other` or the element was found on the previous frame, a wide search runs.
It slides the model over the whole region (plus the context ring) at every scale from 0.3 to the largest that fits the region, in 10 % log steps, each at the smallest pyramid level (an eighth, a quarter, a half or full resolution) that keeps the template at least 8 pixels on its short side, at the last clear blur.
The three best distinct placements are refined with the regular search and judged; only a `found` judgement is accepted, so false matches stay rejected by the same fidelity, slope and correlation rules.
A failed wide search is repeated only after the region changed by a mean of one luma level at quarter resolution, so a static or empty stretch costs one search.

Both ends: when the main track loses frames and the other end's window holds structure (its luma deviation at least 3 noise deviations), the region is also tracked from the other end with that end's template, backwards in time.
It stops once both tracks found three consecutive frames, or the main track eight.
Frames the main track did not find are filled from the other track, converted through the frames both found with the median scale ratio and the median offset between the two box centres (in units of the other track's scale); without such frames nothing is merged.
With an automatic reference the end whose track found more frames leads, but values stay relative to the end picked for its structure (box, scale and blur rebased onto that end's frame when it was measured), so a growing card still reads 0.62 to 1 and not 1 to 1.6.

Colour: a region gets a colour model when its element has distinctive colours.
Candidates are 4-bit colour bins that cover at least 2 % of the reference window, taken at their mean colour.
Two cases are tried, a persistent element first, then a content swap.
Persistent element: the same element is at both ends, at any size and place.
A candidate leads when, at each end, its pixels (within 28) form one patch and at most 0.5 % of the region outside that patch's box (grown by one 4 px cell) lies within 42 of it.
The patch is the largest 8-connected group of cells at least a quarter matched, bridged across gaps of up to two cells, so a colour broken up by a pattern still spans the whole element.
The other candidates join when at least 80 % of their matches at the reference end fall inside the leading colours' box and they are just as rare outside that box at both ends; this is how a darker pattern joins a solid colour.
The kept colours must fill at least half of their box at both ends, the two boxes must have the same aspect within 10 %, and neither box may reach all four sides of the region (that is a background around something, not an element).
The rarity rule is local on purpose: a card that grows to fill most of the region is common in the region at its expanded end, but rare around itself.
The element must also stay visible and connected through the transition, not just appear at both ends: the colour box must read on every frame between the ends, with gaps of at most two frames, and from one reading to the next change scale by at most 0.2 (log units) and move its centre by at most half its size per frame.
Otherwise the persistent model is refused and the content swap rule below is tried.
Content swap: a candidate is kept when at most 0.5 % of the region at the other end lies within 42 (RGB distance) of it, when no other dominant colour of the window that fails that test lies within 42 of it, and when at least 80 % of its matches (within 28) fall inside the box the candidates form together.
In both cases a candidate within 42 of a dominant colour that was not kept is dropped, because it would match that background too.
The model is used only when the kept colours fill at least half of their box and that box holds at least half of the window's luma variance, so a small coloured detail on a white card does not count.
For a persistent element the colour box at the reference end becomes the element box.
For a content swap it does so when the changed-content box covers at least 90 % of the region (the whole region changed, as under a dimming backdrop) and the colour box is under 80 % of it.
With an automatic reference, a region whose element persists in colour at both ends, connected in between, uses the end where the element is larger: the template has the most pixels there, and a grow reads towards 1 as CSS writes it (0.62 to 1, not 1 to 1.6).
Other regions keep the end with more structure.
Per frame, pixels within 28 of a set colour form a mask over the region; 4 px cells at least half matched form 8-connected components, and the largest one's box is narrowed to the rows and columns that hold at least 3 matching pixels and a tenth of the fullest one.
The reading is valid when that box is at least 60 % as full as at the reference and its aspect is within 10 % of the reference; its scale is the square root of the area ratio, and its centre maps to the element box through the reference offset, so it follows the same box and transform conventions as the template.
The template search starts from the colour pose when there is one, which also replaces the wide search.
Each sample in `regions.json` carries `method`:
- `template`: only the template measured the frame;
- `both-agree`: the template and the colour box agree within 0.03 in log scale (scale only on `found` frames) and 3 px or 1.5 % of the box in centre; quality stays;
- `disagree`: both measured but differ beyond that; the template values are kept and quality is halved;
- `colour`: only the colour box measured the frame; status is `found`, scale and position are measured, blur is filled from template frames, opacity is written as 1 (a colour match needs a nearly opaque element) but not marked observed, and quality is the fill ratio against the reference;
- `none`: neither found the element.

On expand-dim-reveal captured at 57 fps, encoded at crf 18, with a region around the card's start and end boxes plus 12 px:
- every frame is found: 58 `both-agree`, 47 `colour` (the dimmed and grown frames, 737 to 1544 ms), 10 `template` (the cross-fade, filled from the last-frame track);
- the template alone follows the growth to scale 0.72 (719 ms), where the dim around the card breaks its context ring;
- scale is within 0.004 of the page at every frame (it reads 0.621 for 0.624), the box centre x within 0.6 px;
- the scale series fits a start of 647.5 ms (640 declared) and a duration of 305.9 ms (310 declared);
- tracking takes 29 s for 115 frames of a 664x580 region, against 21 s before for a result that marked the card `other` on 88 frames.
  The other video tests pass with unchanged tolerances; they take 61 s instead of 51 s.

A phone screen recording (816x1080 after crop, 57 fps, h264) showed a limit of the first colour rule: a solid blue card with a darker pattern, in a 2x2 grid of colourful tiles, grows from 347 to 556 px wide (scale 0.624 to 1 from its top edge, 310 ms from 640 ms, material standard) while it moves right and a backdrop dims around it.
With a region covering the start and end boxes the card was not found on its first 45 frames and the drafted scale row read 0.847 to 1 from 712 ms, while a plain bounding box of the blue pixels measured it exactly.
No colour model was built, because the blue covers most of the region at the expanded end, so it was not rare at the other end.
The expand-in-grid fixture reproduces it: the same geometry, timing and dim (which does not cover the card), with gradient and shape tiles and text around the card.
Captured at 57 fps, encoded at crf 18, with a region of the start and end boxes plus 6 px (neighbour tiles inside):
- before: the reference was the first end, 39 of 79 frames found, all from the template, and no scale row was drafted;
- now: the reference is the last end and every frame is found: 44 `colour` (the static grid and the first growth frames, up to scale 0.83) and 35 `both-agree`;
- scale is within 0.0022 of the page at every frame, and the series fits a start of 648.3 ms (640 declared) and a duration of 299.9 ms (310 declared);
- the drafted scale row reads 0.6225 to 1, from 640.5 ms over 307.5 ms, with the material standard curve;
- with the reference set to the first end, the colour model is refused there (the small card holds 35 % of the region's luma variance), the last-end track fills the frames through the merge, and scale reads 1.606 at the end against 1.603 on the page;
- tracking takes 8 to 12 s for 79 frames, and expand-dim-reveal measures exactly as above.

A notch recording later showed the persistent rule taking two elements for one: a small thumbnail in the closed notch looks like the large album art of the open player, in the same colours and the same place, so the art was read as one element growing from the thumbnail and its drafted rows dropped from medium to low confidence (advisory).
The notch-thumb-on-art variant of notch-expand reproduces it: the compact thumbnail sits inside the art's region and shares the art's cover (two discs on a two-colour checker), and the panel grows from a pill that covers it.
Captured at 60 fps, encoded at crf 18, with regions of the start and end boxes plus 6 px:
- before: the persistent colour model was built (56 frames `both-agree`), every frame was found, frames 0 to 28 at scale 0.31 on the thumbnail, and the art's opacity, y and blur rows were low confidence (fit rms 0.35, 1.57 and 1.95 of the change);
- the template alone did the same once the colour model was taken away: from the faint, blurred art on frame 29 it jumped to the thumbnail (scale 0.85 to 0.52 to 0.32, 78 px in one frame).

Two rules now require the element to stay connected:
- the persistent colour model must read on the frames between the ends (above);
- a `found` template reading must keep its scale within 0.2 (log units) of the prediction per frame since the last found frame, counting at most two frames, or it is judged `other`; this applies to the wide search too.
  Scale steps on the existing fixtures stay under 0.08 per frame.

After both, on the same variant: no colour model, nothing found before frame 29 (483 ms; the art starts entering at 450 ms), and the art rows are medium again: opacity 0.07 to 1, scale 0.81 to 1, y and blur 10.8 to 0 px, all from 455.1 ms over 261.6 ms, like notch-expand itself.
The expand-in-grid and expand-dim-reveal cases measure as above.

## Decision: rest plateaus, loops and colour flips

A phone recording (56 fps, 8 s, 600x1032 after crop) broke the model of an element as what changed between the first and the last frame.
A white sheet with a week strip and a task list slides down about 440 px to reveal a dark summary while the whole page flips from white to near-black, holds, slides back up, and does it all again; the clip ends where it starts.
Regions over the whole clip found nothing that changed between the ends, tight boxes locked onto the task list, and automatic regions returned one blob covering the whole screen.
Cut into one-slide pieces the clip still failed: the page flip changed every pixel of the region, so its tightened box was the whole region.
The sheet-loop fixture reproduces it with its own design: the sheet slides 440 px down in 300 ms (easeOutCubic) at 400 and 4400 ms and back up at 2300 and 6300 ms, while the page background flips the same way.

Rest plateaus: every frame is read once into a quarter-resolution copy.
A frame is still in a region when at most 0.2 % of the region's quarter-resolution pixels changed by more than the noise floor since the previous frame, and five still frames in a row form a rest plateau, represented by its middle frame (or the clip end it holds).
Two frames show the same state when at most 1 % of the pixels differ by more than the noise floor.
When a region shows the same state at both clip ends and a plateau shows another, the region is planned from two anchors, frame 0 and the plateau that differs most from it; every other region keeps the two clip ends.
Plateaus inside a clip whose ends differ are not used: the slow tail of an ease-out or the turn of an overshoot also stands still for five frames.

Travel: the element is the content that travels between the anchors.
Blocks of 64 px at eighth resolution vote for the displacement where their zero-mean luma correlates best (at least 0.9) anywhere in the frame; the most voted displacement that is not a standstill, with at least two votes, is refined with the summed correlation of 32 px blocks at quarter resolution and of the moving blocks at full resolution.
Correlation of zero-mean blocks judges identity on structure: brightness and contrast are normalised per block, so a white sheet on a white page matches the same sheet on a black page.
A 32 px block is moving when it correlates at least 0.8 at the travel and 0.05 better than in place; the moving blocks that stay 8 px inside the region at both anchors make the element box.
The box then grows by up to 32 px on each side, and is trimmed back, to the rows and columns whose pixels agree within twice the noise floor at both anchors; a fitted box under half the moving blocks' box is not a rigid element, and there is no travel.
When no moving block stays inside at both anchors, the box is the moving content inside the region at the first anchor (clipped travel below).
Without travel, the box is the content that changed between the anchors.
The reference is the anchor where the box with a 6 px ring holds more luma variance (the sheet over the dark page), or the anchor that holds the element inside the region when it leaves.
The context ring is left out of the template when its mean luma changes by more than 12 levels between the anchors, so a page that flips around the element does not count against the match.
The element is the same size at both anchors, so it is tracked as a rigid move: scale and blur are fixed from the first pass, which also keeps motion blur from reading as a CSS blur.
Tracking runs from the reference frame to the end of the clip, then from the reference frame back to the start; the other anchor's track, the merge and the rebase work as for clip ends.
A region whose ends differ, whose box did not tighten (at least 90 % of the region) and which has no colour model uses the same travel plan between the clip ends when rigid content travels and stays inside, so a single slide cut from such a clip is tracked the same way.

Automatic regions: a cell also counts when its quarter-resolution mean changes by more than the noise floor against the whole-frame rest plateau before it, so each transition counts on its own, not only against frame 0.
A blob whose box covers at least half the frame is replaced by the content that travels inside it: for each pair of consecutive whole-frame rest states, the travel box at both states, joined and padded by 16 px, with sweeps that overlap by half merged.
It stays one blob only when nothing travels, so a page flip never hides a travelling edge in one whole-screen blob.

On sheet-loop captured at 56 fps (449 frames) and encoded at crf 18:
- with one region over the sheet's travel (x 0, y 84, 600x948): anchors frame 0 and frame 307, reference frame 307, the box 584x487 under the sheet's top edge without a ring, every frame found, and the box top follows the page's sheet top within 3 px on every frame;
- fitted per slide, the box y starts at 400.0, 2299.9, 4400.0 and 6300.0 ms (key 400, 2300, 4400, 6300), lasts 284.9, 292.1, 282.5 and 272.2 ms (key 300) and travels 440.0 to 440.1 px;
- with automatic regions: one region (the whole-screen blob replaced by the sheet's sweep), with the same anchors, reference and box, and the box top again within 3 px of the page on every frame;
- tracking takes 19 to 23 s for each run (up to 48 s while other suites run), against 67 s before for a track that lost the sheet on every frame after the first slide.

## Decision: clipped travel

A cut of the same recording reported a slide of 260.5 px for a sheet that moved about 440 px: tracking stopped at the edge of the region box, and nothing said so.
A region planned from travel bounds its element, since the box is chosen as what the region holds at both anchors.
On such a region a found frame is clipped when its box reaches more than 1 px past the region, or within 1 px of the region edge while its centre moved more than 0.5 px from a neighbouring found frame; frames lost next to a clipped frame join its range, because that is where the element left the region.
Clipped frames keep their measured values, but their position is not observed: `observed.position` is false and the element in `track.json` carries `clipped: true` (every video element carries the field).
`regions.json` lists the ranges per region (`clipped: [{ from, to }]`, frames), `capture.json` lists them under `video.clippedTravel` (`region`, `selector`, `index`, `fromFrame`, `toFrame`, `fromMs`, `toMs`), and a warning names the region and the frames, so spec drafting can mark the distance as a lower bound.
Regions planned from two different clip ends are not bounded: their box is often the whole tightened region and the tracker follows the element past it (motion-spring's region covers only the start of a 200 px move), so they are never marked.
On sheet-loop with a region that ends 52 px under the sheet's first rest (y 84, 600x500), the box is the sheet inside the region at frame 0 and the warnings name frames 23 to 144 (411 to 2571 ms) and 246 to 368 (4393 to 6571 ms), the two trips down and back; with the region over the whole travel there is no warning.

## Decision: crops, the frame edge and content that stays in place

A phone recording (1920x1080, cropped to the 600x1032 phone screen, `--css-scale 1.5`) of the same kind of sheet broke automatic regions: one blob, the whole sheet pressed against the bottom edge, and 9 clipped travel warnings, so the regions had to be declared by hand.
The sheet travels about 64 % of the screen height and is longer than the screen, so at its lower rest only its top shows.
The sheet-loop fixture cropped to 600x640 has the same proportions (440 px of travel, 104 px of sheet in view at the lower rest); before this decision the same fixture lost the sheet on 20 % of frames at a 680 px crop (travel read 436 px), found no travel at all at 600 px, and at 800 px gave one region with the summary inside it.

Four rules changed:
- Travel voting uses 64 px blocks at half-block steps, so content near the frame edge still has a block that fits at both states whatever the region's origin.
- Refining a displacement counts only the blocks that stay in the frame over the whole search window; before, a block pushed out of the frame scored -1, which pulled the peak towards shifts that kept more blocks inside (436 instead of 440 px).
- A fitted row or column also needs a mean change within the noise floor, not only 90 % of its pixels within twice the floor, so rounded corners over a page that flips are trimmed; on the 640 px crop they had held the correlation at 0.946, under the quality gate, and the sheet was lost at its upper rest.
- When no moving block stays inside the region at both states and every side the content moves towards is a frame edge, the box is the moving content that stays in view at both states instead of the content that leaves.

Clipped travel is a region cutting the element, not the frame: a region side that lies on the frame edge never marks a frame clipped.
An element larger than the frame is tracked by the part that stays in view, which includes its leading edge.

Content that stays in place: inside a whole-screen blob with travel, each transition between rest states also marks 4 px cells outside the travelling element whose 12 px window holds structure (luma deviation 4) where it shows.
The element covers its box at each state and is carried to the frame edge on each side where its box comes within 32 px (one travel block) of that edge at either state, because it continues past the frame there.
Cells within 16 px outside that cover are its edge (fitting trims up to a few rows, and the window reaches 4 px) and never count.
Cells the element reveals or covers count when the uncovered state shows structure; cells outside it at both states count when they changed, except when their zero-mean structure correlates 0.9 or more in place, which is a recolour such as text over a page that flips.
Transitions without travel are skipped, because there the element cannot be told apart from what it reveals.
Marked cells within 24 px join, groups under 16 cells are dropped, and each group becomes a region padded by 8 px, planned from the rest state where most of its cells show: that frame is the reference, the rest state that differs most is the other anchor, the box is the changed content, and there is no track from the other anchor, which holds whatever covers the content there.
Such a region is not bounded, so it is never marked clipped.

On sheet-loop at 56 fps (449 frames), encoded at crf 18 and cropped to 600x640:
- automatic regions are the sheet (box 562x95 under its top edge at the lower rest, every frame found, the top edge within 3 px of the page on every frame), the summary title and subtitle (208x116) and the summary bars (532x180); the header only flips colour and gets no region;
- no clipped travel warning;
- the capture takes about 47 s, extraction included, for the three regions.

Uncropped, the same fixture now gives the sheet (box 580x484 instead of 584x487, the corners trimmed, every frame found) plus the same two summary regions.

## Decision: cloning a recording with --like

`--like <videoCaptureDir>` used to take only fps, duration and a load trigger, so a clone of a phone recording was captured at 1280x800 and scale 1, and every look check failed (background ΔE 92.6, SSIM 0.25) until the viewport was set by hand; the density could not be matched at all.
The clone now also takes the recorded screen: the viewport is the crop divided by `cssScale` (rounded), and the device scale factor is `scale * cssScale` (the css scale unless `--width` rescaled the frames), so clone frames have the reference frames' pixel size: 600x1032 at `--css-scale 1.5` gives 400x688 at 1.5x.
Explicit flags still override, and the clone's `capture.json` records what was derived under `options.likeVideo` (capture, crop, cssScale, scale, frameSize, viewport, deviceScaleFactor).
A crop that does not divide by the css scale gives frames up to one pixel off.

## Limits

- Uniform scale and Gaussian blur only: rotation, non-uniform scale, perspective and clip-path changes lower the correlation and are not measured; they read as reduced opacity or a lost element.
- Scale changes under about 1 % are treated as noise and blurs under one frame pixel as none, so the last frames of a blur that eases out read as 0 a little early.
- The box is the tightened region scaled about its centre, so when the region holds background around the element (a blurred start spreads the changed area), the reported box is larger than the element; scale itself is unaffected.
- The blur model assumes the element sits on a flat background: blurring the template also blurs whatever surrounds it in the reference frame, so busy surroundings bias blur.
- Blur and fading both lower edge contrast; the model separates them by shape, but on a faint element (proxy under 0.2) neither scale nor blur is measured, and a blur measured while the element also fades can trade a little blur for opacity.
- The quality thresholds are calibrated on h264 crf 18 with the default noise floor; heavier compression needs a higher `noiseFloor`, or true faint frames read as `other`.
- An element whose region already holds a similar object at the expected place (a thumbnail swapped for the same artwork) still matches it; the check only rejects content the model does not explain.
- An element that reappears after a gap far from its last clear pose is found again only by the wide search, which runs on busy frames that changed since its last failure, and only at the last clear blur.
- Blur is measured up to about 35 reference pixels; at 16 to 20 px the estimate reads 4 to 6 % low.
- An element that fades in from opacity 0 while it scales and unblurs shows its start values only after it becomes visible, and h264 hides the faintest frames.
  On the css-blur-scale-in fixture (opacity, `scale: 0.92` and `blur(12px)` in over 600 ms, `cubic-bezier(0.22, 1, 0.36, 1)`) at crf 18, the first frame with opacity 0.125 reads a contrast of 0.02 (0.125 on the lossless frames), so the video starts at blur 10.1 and scale 0.92 for the first card, and 6.8 px and 0.945 for the second.
  Once a card's opacity passes 0.3, opacity is within 0.065 of the DOM, scale within 0.009 and blur within 1.5 px.
  The fitted rows still come out about 320 ms long instead of 600 ms, with an `easeOutCirc`-like curve: this ease-out puts a quarter of its change into the first two frames, and the exact DOM series with only its first visible frame zeroed fits the same 364 ms `easeOutCirc`.
  Even a lossless encode fits 370 to 420 ms, because small opacity proxy deviations (up to 0.05 mid-move) are enough to change the fit.
  So verifying such a video against a DOM clone fails on duration and distance; it is a limit of what the pixels hold plus the fit's sensitivity, not of tracking.
  ADR 0003 covers how spec drafting and verify now handle such partly observed rows.
- The opacity proxy also reads the context ring around the element, so a background that changes around an opaque element lowers it: on expand-in-grid the first template frame under the fading dim reads 0.90, and the draft holds an opacity row from 0.9 to 1 that the page does not have.
- Colour-only changes are invisible to the tracker, because it works on luma and ignores brightness scaling.
- The colour box assumes a sharp, opaque element: blur or fading erodes its edges, so the reading shrinks or fails, and an element whose colours also appear elsewhere in the region, or that is partly covered, has no valid colour reading.
- Merging the two ends needs frames both tracks found; a cross-fade between two different contents with no such frame keeps the other end's frames out.
- Overlapping elements: when another moving element enters the template area, the match follows whichever dominates; declare tighter regions or crop.
- Automatic blobs merge elements closer than about one cell plus the blur (about 6 px); declare regions in that case.
- Rest plateaus are used only when a region ends in the state it starts in; a clip that moves through three states keeps its two ends as anchors and finds the middle state by continuity.
- A region planned from travel is a rigid move: an element that also scales or blurs between its rest states, or only in the middle of the move, is not measured as scaling or blurring.
- Travel needs blocks with structure that look alike at both anchors; a flat panel with no content does not vote and is planned from the changed content.
- A found reading whose scale jumps by more than 0.2 (log units) per frame is refused, so an element that really grows that fast, or that reappears after a gap at a very different size, is not followed; the other anchor's track can still fill it.
- An element is unobservable while fully transparent; the extrapolation above covers entrances that move and fade together, not ones that move a long way before appearing.
- Compression noise sets the floor: on h264 crf 18 the position jitters by about 0.1 px and the opacity proxy by about 0.03; heavier compression needs a higher `noiseFloor`.
- Gif palettes and dithering add noise, and centisecond delays quantise timing to 10 ms.
- Variable frame rate recordings are handled by the timestamp rule above, but the default fps comes from the header average.
- A full-frame decode is done once to read timestamps, so cost grows with the position of `start` in long recordings.
- Verify can compare a video reference with a DOM clone: `--map card=.card` renames the clone's track keys to the region names (`card[2]=.x[0]` maps one element).
  Only fps must match, so the clone is captured with `--like <videoCaptureDir>`, which takes fps, duration, a load trigger and the recorded screen's size and scale from the video (see cloning a recording above); viewport, trigger and seed are not compared against a video.
  Rows compare change, timing and easing, never absolute offsets.
  Distances are CSS pixels on both sides: the video side is scaled by `cssScale`, and a DOM `translateY` moves the box y too, so video box rows are compared with the clone's box x and y.
  Relative distances are not used against a video, because the region box and the element box differ in size.
  Pixel fidelity needs two DOM captures and is a setup error against a video.

## Consequences

- Spec drafting and verify run unchanged on video captures; every row is `measured`, with no declared animations.
- On the css-fade-up-stagger fixture recorded to mp4 at 60 fps, card starts land within 4 ms of the answer key and the easing within 0.035 of it.
- Fixing this exposed a divide-by-zero in `normalise` for there-and-back moves that end exactly where they started; they are now scaled by their peak.
