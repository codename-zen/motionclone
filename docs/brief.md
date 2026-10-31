# motionclone brief

## Goal

Measure motion on the web as numbers, so a coding agent (or a person) can build its own version and prove it moves the same way.
The output that matters is a per-element verdict such as "card 3 starts 40 ms late, overshoot 6 % vs 12 %", not a screenshot.
The rebuild is the user's own code; the tool never ships someone else's assets.

## Principles

- Numbers over eyeballing: every spec row becomes an automatic pass or fail.
- Deterministic by default: the same page captured twice gives identical frames.
- Cheap for agents: images are produced only for rows that fail.
- Cross-platform: Windows, macOS and Linux.
- Motion first: fonts, images, shaders and models are never downloaded unless asked, and then with a licence warning.
- Proven correct: fixture pages with known animations are the ground truth for every release.

## Stack

| Part            | Choice                                                                                |
| --------------- | ------------------------------------------------------------------------------------- |
| Runtime         | Node 26 LTS for development and CI (pinned per project through pnpm), engines `>=24`  |
| Language        | TypeScript 7, source run directly by Node type stripping, compiled to `dist/` for npm |
| Browser         | Playwright + Chrome DevTools Protocol                                                 |
| Video           | ffmpeg-static                                                                         |
| Image diff      | pixelmatch + SSIM                                                                     |
| Spec schema     | zod, `spec.json` is the contract                                                      |
| Tests           | vitest + fixture pages                                                                |
| Lint and format | Biome                                                                                 |
| Agent access    | CLI, MCP server (`motionclone mcp`), thin agent skill                                   |
| Package manager | pnpm                                                                                  |

## Architecture

```
src/
  capture/   browser, triggers, virtual time, CDP animation events, tracker, lossless frames
  measure/   per-element motion windows, stack detection
  fit/       named presets, free cubic-bezier, damped spring -> CSS linear()
  compare/   per-row verdict, track diff, pixel diff on rest frames only
  report/    verdict.json, sheets for failing rows only
  cli.ts
  mcp.ts
skill/       SKILL.md on top of the CLI
fixtures/    pages with known animations and their answer keys
```

Flow:

1. `motionclone capture` records the reference.
2. `motionclone spec` drafts `spec.json` from the capture.
3. The agent builds the motion in the project's own stack.
4. `motionclone capture` records the rebuild with the same settings.
5. `motionclone verify` prints pass or fail per spec row with numeric differences.
6. Repeat until every row passes or the round limit is hit; residuals are reported with a reason.

## Methods

### Capture

- Subscribe to CDP Animation events before navigation, so finished transitions and cross-origin stylesheets are kept.
- Read library timelines when present (GSAP global timeline, Motion values) while they run.
- Virtual time: Playwright clock for JavaScript time, CDP animation pause and seek for CSS and WAAPI, so every frame is exact.
- Lossless PNG frames from screenshots, never a compressed video.
- Track every match of a selector, indexed, with box, opacity, transform, filter, clip-path, colour, background and box-shadow.
- Fix the crop at trigger time; warn when a tracked element leaves it.
- Triggers: load, scroll, scroll-to, hover, leave, pointer path, drag, click, none.
- Logged-in pages through a saved storage state or a running Chrome over CDP.

### Measure and fit

- Per-element motion windows from tracks; alignment by trigger time, any offset reported as an error.
- Easing fit: named presets, free cubic-bezier by least squares, damped spring through overshoot and logarithmic decrement, steps, multi-segment keyframes, there-and-back motion.
- Springs export as Motion parameters and as a CSS `linear()` curve; every fit reports its error.
- Distances relative to element size, samples interpolated.
- Stack detection is reported (CSS, WAAPI, GSAP, Motion, canvas, Lottie).

### Verify

- Motion is scored on tracks: timing, easing, direction, speed and distance per element.
- Pixels (pixelmatch and SSIM) are compared on rest frames only.
- Guardrails flag common rebuild mistakes: animating layout properties, ease-in on entrances, no `prefers-reduced-motion`.

## Scope

- v1: DOM motion from a URL (CSS, WAAPI, GSAP, Motion).
- v1.1: video and gif input.
- v2: canvas, WebGL and WebGPU tracing.

## Milestones

| #   | Milestone                                                                                     | Done when                                                                                              |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| M0  | Fixture pages: fade-up stagger, hover, spring, scroll-linked, marquee, GSAP, Motion, and more | Each fixture has an answer key with its declared values                                                |
| M1  | Capture                                                                                       | Two captures of a fixture are byte-identical on three OSes; CDP events equal the declared values       |
| M2  | Fitting                                                                                       | Fixture beziers and springs are recovered within tolerance (control points ±0.03, damping ratio ±10 %) |
| M3  | Verify                                                                                        | A deliberately wrong fixture variant fails on the right row                                            |
| M4  | CLI, MCP and skill                                                                            | An agent rebuilds one fixture until it passes, end to end                                              |
| M5  | Video input                                                                                   | A screen recording of a fixture gives a spec close to its answer key                                   |
| M6  | Release                                                                                       | npm package, README, demos from our own designs                                                        |

## Risks

- The CDP Animation domain is experimental; fallback is hooking `Element.animate` and the `animationstart` and `transitionrun` events.
- Rendering differs across operating systems; reference and rebuild are always captured on the same machine.
- Trust wins over features: M0 to M3 must be solid before any promotion.
