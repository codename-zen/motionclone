# ADR 0001: virtual time for capture

## Status

Accepted, 2026-10-31.

## Context

Two captures of the same page must give byte-identical frames.
A browser has two independent clocks that move animations: JavaScript time (Date, performance.now, timers, requestAnimationFrame) and the document timeline that drives CSS animations, CSS transitions and WAAPI.
Playwright's `page.clock` fakes only the first one.
It does not touch `document.timeline`, so CSS and WAAPI keep running in real time and drift between screenshots.

## Decision

JavaScript time uses Playwright's clock, paused before navigation with `page.clock.pauseAt(epoch)` and moved only by `page.clock.runFor(ms)`.
We call `pauseAt` without `install`: Playwright replays its clock log in every new document and advances the tick counter by the real wall-clock gap between the logged `install` and `pauseAt` calls.
That gap is 0 or 1 ms at random, which shifts `performance.now()` and the requestAnimationFrame phase, and was enough to make GSAP frames differ between runs.
With `pauseAt` alone, `performance.now()` starts at 0 and the replay has no real-time component.

The document timeline is frozen with CDP `Animation.setPlaybackRate(0)` before navigation; the rate carries over to the new document.
An init script then plays the animations itself: at every captured frame it walks `document.getAnimations()` and advances each running animation's `currentTime` by the virtual time since it was last seen, scaled by its playback rate.
New animations start at the virtual time they were created; `Element.prototype.animate` is hooked so animations created between frames get their exact creation time.
Because the frozen timeline reads 0, the init script reports `document.timeline.currentTime` as virtual time (`performance.now()`) and maps `Animation.startTime` reads and writes onto `currentTime`.
Without this, libraries that sync through `startTime` (Motion sets it to its frame timestamp) leave animations waiting forever.
We chose page-side `currentTime` over CDP `Animation.seekAnimations` because it is one evaluate per frame instead of a protocol round trip per animation, respects animations the page paused, and keeps the `finished` promise and events working.

Every captured frame is a rendering opportunity, as in a real browser: animations are advanced, then pending requestAnimationFrame callbacks run with the frame time, then animations they created are picked up.
The fake clock alone fires rAF only on its own 16 ms grid, so a frame taken right after load or a trigger showed a state no real browser paints.
Example: GSAP `from()` renders lazily on its first ticker tick, so without the flush frame 0 showed the end state and jumped to the from-state at the next frame.
A real browser also never paints at the load instant, so the first frame is 16 ms of JS time after the load event (one 60 Hz frame).
For the load trigger that first frame is t=0; animations created during load stay pending until it and start at t=0, as pending animations do in a real browser.
JavaScript timelines (GSAP, Motion, timers) count from the moment their script ran, so a delay declared there shows up 16 ms earlier relative to t=0; this is real browser behaviour and cancels out when reference and rebuild are captured the same way.

Each frame is: `runFor` to the frame time, run due trigger actions, advance animations and flush rAF, sample the tracker, take a lossless PNG screenshot.
Each scroll step sets the position with `window.scrollTo({ behavior: "instant" })`, so CSS smooth scrolling never animates on the compositor in real time.
`scrollY` changes at once, but scroll timelines and scroll events only catch up at the next rendering update, which Chromium schedules in real time.
Without a wait, the tracker sometimes read the previous step's scroll-driven values, so track.json and self-verify differed between runs.
The step therefore waits for one rendering update (the first callback of an IntersectionObserver, delivered after it) before the frame is sampled.
Frame times are whole milliseconds (`round(k * 1000 / fps)`) so timers fire at the same points every run.
`Math.random` is replaced with a seeded mulberry32.

## What Playwright's clock does not cover

- The document timeline: CSS animations, CSS transitions and WAAPI (handled above).
- Scroll-driven and view timelines: they follow scroll position, which only triggers change, so they are not seeked.
- Compositor-only work outside animations, such as smooth scrolling, video, and canvas or WebGL frames drawn from real time sources (`requestVideoFrameCallback`, media clocks); these are not made deterministic.
- Network timing: resources that arrive at different moments can still change what is painted; local fixtures avoid this.
- Workers and iframes from other origins keep their own clocks.

## Consequences

- Captures of every M0 fixture (CSS, WAAPI, GSAP, Motion, scroll-driven) are byte-identical across runs on the same machine.
- The capture is not real time; wall time is dominated by screenshots (a 1 s, 30 fps capture of a small page takes under a second here).
- animations.json leaves out CDP `backendNodeId`: it is a per-session counter that differed between otherwise identical runs.
- CDP `startTime` values are meaningless under a frozen timeline, so records carry `startMs`, the virtual creation time relative to the trigger.
- Pages that compare `document.timeline.currentTime` with an animation's raw internal start time outside the patched getters could still see inconsistent values.
