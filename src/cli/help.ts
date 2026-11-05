export const MAIN_HELP = `motionclone: measure web motion as numbers, rebuild it, prove the rebuild moves the same way.

Usage: motionclone <command> [options]

Commands:
  capture <url|path|video>   Record frames and element tracks (--help for options)
  probe <video|gif>    Print size, frame rate, duration, codec, the device screen and the motion windows
  spec <captureDir>    Draft spec.json from a reference capture
  verify <spec|captureDir> <cloneDir>   Check a clone capture against the spec
  report <verdict.json>   Print a verdict as markdown
  side-by-side <refDir> <cloneDir>...   Compose captures into a labelled GIF or MP4
  sheet <refDir> <cloneDir>   Reference, clone and difference at rest frames (design check)
  mcp                  Start the MCP server on stdio

Options:
  -h, --help       Show help (also per command)
  -v, --version    Print the version
`;

export const HELP: Record<string, string> = {
	capture: `Usage: motionclone capture <url|path> --out <dir> [options]
       motionclone capture <cloneUrl> --like <refCaptureDir> --out <dir>

  --out <dir>             Capture directory (required)
  --like <dir>            Reuse every option of that capture except url and out
  --viewport WxH          Default 1280x800
  --fps <n>               Default 60
  --duration <ms>         Capture length after the trigger (required without --like)
  --trigger <type>        load | none | hover | leave | click | scroll | drag (default load)
  --target <css>          Element for hover, leave, click, drag
  --scroll-to <px|css>    Destination for the scroll trigger
  --drag "x,y@ms ..."     Path for the drag trigger: CSS px from the target's centre at ms after
                          the trigger; press at the first point, release at the last
  --track "css, css"      Selectors tracked every frame
  --clip x,y,w,h          Crop rectangle
  --selector <css>        Crop around this element
  --pad <px>              Padding for --selector (default 16)
  --pre-roll <ms>         Idle time recorded before the trigger
  --wait-before <ms>      Idle time before the trigger fires
  --pre-js <code|file>    JavaScript run after load, before the trigger (a path to an existing .js
                          file is read); statements and await work, e.g. to set a class
  --pre-click <css>       Click this element before the trigger; repeatable, run in order,
                          skipped with a warning when not found (cookie banners)
  --color-scheme <s>      light | dark | no-preference
  --reduced-motion        Emulate prefers-reduced-motion: reduce
  --storage-state <file>  Playwright storage state (logged-in pages)
  --cdp-url <url>         Attach to a running Chrome
  --seed <n>              Math.random seed (default 1)

Video or gif input (.mp4 .mov .webm .gif) has its own options and ignores the page ones:
  motionclone capture <file> --out <dir> [--start t] [--end t] [--fps n]
      [--crop x,y,w,h] [--width w] [--css-scale n]
      [--region "name=x,y,w,h"]... [--auto-regions]
  --start, --end          Seconds, 1500ms or m:ss.s
  --crop x,y,w,h          Crop in video pixels
  --width <px>            Scale the cropped frames to this width
  --css-scale <n>         Video pixels per CSS pixel (2 for a 2x screen, default 1)
  --region name=x,y,w,h   Element to track, in cropped video pixels; repeat per element.
                          card[0], card[1] make an indexed group like DOM items.
  --auto-regions          Find moving blobs (the default); named blob[0], blob[1]...
`,
	spec: `Usage: motionclone spec <captureDir>

Drafts <captureDir>/spec.json from the capture and prints one line per row.
`,
	verify: `Usage: motionclone verify <spec.json|captureDir> <cloneDir> [options]

  --fidelity <mode>       motion (default) | look (also checks colours, type sizes and layout) | pixel (look plus rest-frame pixels)
  --pixel-threshold <n>   Allowed mean mismatch fraction on rest frames
  --reduced-clone <dir>   Clone capture taken with --reduced-motion
  --map ref=clone         Rename clone selectors to the reference names (repeatable):
                          card=.card maps every index, card[2]=.x[0] one element.
                          Needed when the reference is a video.
  --out <dir>             Where verdict.json, report.md, sheets/ go (default cloneDir)
  --json                  Print verdict JSON instead of the report

Exit code: 0 all rows pass, 1 rows fail, 2 setup error or bad input,
3 no checks (no motion or look row was checked, so nothing was compared).
`,
	probe: `Usage: motionclone probe <video|gif> [--screen] [--sheet <dir>] [--every <ms>]

Prints size, frame rate, duration and codec of a recording, then:
  screen:     the device screen inside the frame (bounded by a bezel or a plain background)
  suggested:  --crop and --css-scale for capture; the crop spans whole CSS pixels
  motion:     time windows where the screen changes, to pick --start and --end

  --screen        Print the screen guess even when unsure (it is left out otherwise)
  --sheet <dir>   Write <dir>/contact-sheet.png: a labelled frame every --every ms,
                  cropped to the screen when one is found
  --every <ms>    Contact sheet interval (default: at most 48 frames)
`,
	report: `Usage: motionclone report <verdict.json>

Prints the verdict as markdown.
`,
	"side-by-side": `Usage: motionclone side-by-side <refDir> <cloneDir> [<cloneDir>...] --out file.gif|file.mp4

  --labels "A,B,..."   One label per input, reference first (default Reference, Rebuild)
  --from <ms>          Start, ms from each capture's t=0 (default: where all captures overlap)
  --to <ms>            End, same clock
  --fps <n>            Output frame rate (default: the reference's, at most 30)
  --width <px>         Largest picture width (default 1280)
  --crop x,y,w,h       Crop of each input; repeat once per input, or once for all ("-" keeps a frame whole)
  --offset "0,120"     Per input, ms into that capture that lines up with t=0 of the others
  --hold <ms>          Show the last frame this long before the loop restarts (default 0)

Different frame sizes are scaled to a common height and padded.
A verdict.json in a clone directory adds "PASS 4/4", "FAIL 1/4" or "NO CHECKS" under its label.
GIF warns above 8 MB; MP4 is H.264 yuv420p.
`,
	sheet: `Usage: motionclone sheet <refDir> <cloneDir> --out <dir>

Writes <dir>/design-sheet.png: reference, clone and difference for the first frame,
the last frame and each still stretch of the reference, labelled with time.
Works for page and video references. Use it to compare the look, not the motion.
`,
	mcp: `Usage: motionclone mcp

Starts the MCP server on stdio. Tools: capture, probe, draft_spec, verify, report, side_by_side, design_sheet.
`,
};
