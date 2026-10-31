# motionclone

Measure web motion as numbers, rebuild it, and prove the rebuild moves the same way.

Coding agents rebuild a layout well from a screenshot, but they cannot watch motion.
They guess the timing, pick a generic ease-in-out and call it done.
motionclone records the motion you point at, turns it into a spec with exact numbers, records your rebuild the same way, and tells you per element what is still off:

```text
- .card[2] opacity starts 120 ms late (want 380, got 500)
- .card[2] opacity starts 210 ms after .card[1].opacity (want a 90 ms stagger gap)
```

It works as a CLI, as an MCP server for any agent, and with an agent skill that runs the loop until every row passes.

## What it measures

- Start, duration and end of every moving element, per property (opacity, translate, scale, rotate, size).
- Easing: named presets, any cubic-bezier, springs (with stiffness, damping and a CSS `linear()` curve), steps.
- Staggers between siblings, overshoot, distance relative to the element size.
- Elements that must stay still.
- Pixels on rest frames (mismatch and SSIM), enforced only when you ask for pixel fidelity.

Sources: live pages and local HTML (CSS animations and transitions, the Web Animations API, GSAP, Motion and other JavaScript animation), and videos or gifs (screen recordings, exported prototypes).

## Install

motionclone needs Node 24 or later.
It is not on npm yet; install it from source:

```sh
git clone https://github.com/codename-zen/motionclone
cd motionclone
pnpm install
pnpm exec playwright install chromium
pnpm build
npm link        # puts `motionclone` on your PATH
```

The first install downloads Chromium for Playwright and a static ffmpeg build.

## Quick start

Record the reference, draft the spec, record your rebuild with the same settings, then verify:

```sh
motionclone capture https://example.com --out ref --duration 1500 --track ".hero h1, .card"
motionclone spec ref
motionclone capture http://localhost:5173 --like ref --out mine
motionclone verify ref mine
```

`spec` prints one row per element and property:

```text
8 motion rows, 1 still elements
.card[0].opacity  start 200 ms  duration 700 ms  cubic-bezier(0.16, 1, 0.3, 1) (easeOutExpo)  declared/high
.card[1].opacity  start 290 ms  duration 700 ms  cubic-bezier(0.16, 1, 0.3, 1) (easeOutExpo)  declared/high
...
```

`verify` prints a table and a list of fixes, writes `verdict.json`, `report.md` and comparison sheets for the failing rows only, and exits with 0 when every row passes, 1 when rows fail and 2 on a setup error:

```text
# motionclone verify: FAIL

7 of 9 rows pass. Fidelity: motion.

| id | result | start | duration | stagger gap | easing | overshoot | distance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| .card[1].opacity | pass | 290 / 290 | 700 / 700 | 90 / 90 | 0.000 | 0.0 / 0.0 | 1.000 / 1.000 |
| .card[2].opacity | FAIL | 380 / 500 ! | 700 / 700 | 90 / 210 ! | 0.000 | 0.0 / 0.0 | 1.000 / 1.000 |
...
```

`--like ref` copies every capture setting of the reference except the url and output folder.
A comparison is only fair when both sides are recorded the same way, and `verify` refuses captures whose settings differ.

### Triggers

`--trigger` starts the motion: `load` (default), `none` for loops, `hover`, `leave` and `click` with `--target <css>`, and `scroll` with `--scroll-to <px|css>`.
Pages behind a login work with `--storage-state <file>` (a Playwright storage state) or `--cdp-url` to attach to a Chrome you are logged in to.

### From a video or gif

```sh
motionclone probe loader.mov
motionclone capture loader.mov --out ref --start 0:03 --end 0:05 --crop 320,180,960,540 --css-scale 2 \
  --region "card[0]=40,60,280,160" --region "card[1]=340,60,280,160"
motionclone spec ref
motionclone capture http://localhost:5173 --like ref --track ".card" --out mine
motionclone verify ref mine --map card=.card
```

Regions name the elements to follow in the video (`card[0]`, `card[1]` form a group like DOM siblings); without `--region` moving blobs are found automatically.
`--css-scale 2` converts a recording of a 2x screen to CSS pixels.
`--map` tells `verify` which selector in your rebuild plays each region.

## With an agent

Start the MCP server and add it to your agent, for example Claude Code:

```sh
claude mcp add motionclone -- motionclone mcp
```

Tools: `capture`, `probe`, `draft_spec`, `verify` and `report`.
Answers stay small: counts, the failing rows with their fix messages, and file paths.

The agent skill in [`skill/SKILL.md`](skill/SKILL.md) teaches the loop: scope, capture, spec, build in the project's own stack, capture with `--like`, verify, fix the row the verdict names, and stop after five rounds with an honest list of what still differs.
Copy the `skill` folder to your agent's skills folder (for Claude Code: `~/.claude/skills/motionclone`).

## How it works

- **Capture** runs Chromium with a virtual clock: JavaScript time, timers, `requestAnimationFrame` and CSS or Web Animations all advance together, frame by frame, and each frame is saved as a lossless PNG.
  Two captures of the same page are byte-identical.
- Animations are recorded through the Chrome DevTools Protocol from the moment the page opens, so animations that already finished are kept with their declared timing and easing.
- A tracker samples every match of each `--track` selector on every frame: box, opacity, transform, filter, clip-path and colours.
- **Spec** uses the declared CSS or Web Animations values when they match the track, and fits the track otherwise (JavaScript timelines, springs, video).
- **Verify** measures the rebuild the same way and checks each row against its tolerances: timing ±80 ms, stagger gaps ±40 ms, easing within 0.05 progress, distance ±10 %, overshoot ±5 points.

Design notes: [virtual time](docs/adr/0001-virtual-time.md), [video input](docs/adr/0002-video-input.md).

## Limits

- Video input follows sideways and up-down movement; scale, rotation and colour-only changes in a video are not measured.
- Canvas, WebGL and WebGPU drawing is not traced yet; their motion is only visible as pixels.
- A looping `steps()` animation cannot be fitted yet, and `steps(n, start)` and `steps(n, end)` look the same in a track.
- JavaScript timelines count from when their script ran, 16 ms before the first frame, so their declared delays read 16 ms earlier; this cancels out because both sides are captured the same way.

## Use what you may

motionclone measures motion so you can build your own.
Fonts, images, code and brand assets on other sites belong to their owners; by default motionclone copies none of them, only numbers about how things move.

## Development

```sh
pnpm test             # vitest: fixtures, capture, fitting, verify, CLI, MCP, video
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

The `fixtures` folder holds pages whose animation values are known; the tests check that motionclone recovers them.
`fixtures/_variants` holds deliberately wrong versions that must fail on exactly the right rows.
CI runs on a self-hosted Linux runner, see [docs/ci.md](docs/ci.md).

## License

[MIT](LICENSE)
