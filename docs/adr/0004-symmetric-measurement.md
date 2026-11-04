# ADR 0004: measure the clone the way the reference was measured

## Status

Accepted, 2026-11-03.

## Context

Spec drafting takes a row's start, duration and easing from the reference's declared CSS or WAAPI animation when one explains the track (`src/spec/declared.ts`), and from a free fit otherwise.
Verify always measured the clone with a free fit, where delay, duration and curve shape move together.
For an overshooting curve sampled coarsely the free fit trades start against duration.
On notch-expand at 30 fps, `.title` translateY (`cubic-bezier(0.34, 1.4, 0.64, 1)`, 500 ms from 480 ms) fitted 448.8 ms and 444 ms on a capture whose track was identical to the reference, and self-verify failed with "ends 87 ms early".

## Decision

Verify measures each clone row the same way the spec measured the reference.
When the clone capture has a CSS or WAAPI animation that explains the clone's motion for that row, matched exactly as spec drafting matches it, the row uses that animation's start, duration and easing.
Otherwise, as for script-driven clones, the clone's start and duration come from a fit with the spec row's easing held fixed, the same timing-only fit the easing deviation already uses.
The free fit only names the clone's easing in messages.
Step easings keep the free fit's timing, because their plateaus defeat the timing optimiser and the free fit already searches them on a grid.
With `--map`, the clone's animations are renamed along with its track.
The clipped frames come from `clipped: true` on the element in `track.json` or from `video.clippedTravel` in `capture.json` (ADR 0002).
When a video tracker flags its element as clipped at the region edge during a row's motion, the reference shows only part of the travel.
That row's `distanceObserved` is `lower-bound`: a clone that moves further passes the distance check, a clone that moves less than the bound minus the tolerance fails, and the verdict row carries a note.

## Consequences

- notch-expand passes self-verify at 30 and 60 fps, and so does the same motion with other text and colours.
- A clone with a different easing still fails on easing, because the easing deviation is unchanged; wrong timings still fail on timing.
- Every wrong-variant test fails on the same rows as before.
- `measureClone` takes the spec row, and verify reads the clone's `animations.json`.
