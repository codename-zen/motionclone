import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { dragPointAt } from "../src/capture/triggers.ts";
import { buildCaptureInput, dragPathOf } from "../src/cli/capture-args.ts";
import { readTrack } from "../src/measure/elements.ts";

// A knob that follows a pressed pointer and springs back to its rest place with a 200 ms transition on release.
const PAGE = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;height:600px}
#knob{position:absolute;left:100px;top:100px;width:80px;height:40px;background:#123;touch-action:none}
#knob.back{transition:transform 200ms linear}
</style>
<div id="knob"></div>
<script>
const knob = document.getElementById("knob");
let from = null;
knob.addEventListener("pointerdown", (e) => {
  knob.setPointerCapture(e.pointerId);
  knob.classList.remove("back");
  from = e.clientY;
});
knob.addEventListener("pointermove", (e) => {
  if (from !== null) knob.style.transform = "translateY(" + (e.clientY - from) + "px)";
});
knob.addEventListener("pointerup", () => {
  from = null;
  knob.classList.add("back");
  knob.style.transform = "translateY(0px)";
});
</script>`;

let root: string;
let page: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-drag-"));
	page = join(root, "page.html");
	await writeFile(page, PAGE);
});
afterAll(() => rm(root, { recursive: true, force: true }));

const PATH = [
	{ x: 0, y: 0, atMs: 100 },
	{ x: 0, y: 120, atMs: 300 },
];

const capture = (name: string) =>
	captureMotion({
		url: page,
		outDir: join(root, name),
		durationMs: 600,
		fps: 50,
		track: ["#knob"],
		trigger: { type: "drag", target: "#knob", path: PATH },
	});

describe("drag trigger", () => {
	it("presses, moves on every frame along the path and releases on the virtual clock", async () => {
		const s = await capture("drag");
		expect(s.warnings).toEqual([]);
		const track = await readTrack(s.outDir);
		const y = (t: number) =>
			track.frames.find((f) => f.t === t)?.elements["#knob"]?.[0]?.y;
		expect(y(80)).toBe(100);
		expect(y(200)).toBe(160);
		expect(y(280)).toBe(208);
		expect(y(300)).toBe(100 + 120);
		// Released at 300 ms: the 200 ms transition takes it back by 500 ms.
		expect(y(400)).toBeCloseTo(160, 0);
		expect(y(560)).toBe(100);
		const again = await capture("drag-again");
		expect(await readFile(join(again.outDir, "track.json"), "utf8")).toBe(
			await readFile(join(s.outDir, "track.json"), "utf8"),
		);
	});

	it("reads the path from the command line", async () => {
		expect(dragPathOf(" 0,0@100   0,120@300 ")).toEqual(PATH);
		expect(() => dragPathOf("0,0@100 0;120@300")).toThrow(
			'--drag: cannot read "0;120@300"; write points as x,y@ms, such as 0,300@1300',
		);
		const input = await buildCaptureInput({
			url: page,
			out: join(root, "cli"),
			duration: 600,
			trigger: "drag",
			target: "#knob",
			drag: "0,0@100 0,120@300",
		});
		expect(input.trigger).toEqual({
			type: "drag",
			target: "#knob",
			path: PATH,
		});
		await expect(
			buildCaptureInput({
				url: page,
				out: join(root, "cli"),
				duration: 600,
				trigger: "drag",
				target: "#knob",
			}),
		).rejects.toThrow("--trigger drag needs --target and --drag");
	});

	it("is on a straight line between points", () => {
		expect(dragPointAt(PATH, 50)).toEqual(PATH[0]);
		expect(dragPointAt(PATH, 200)).toEqual({ x: 0, y: 60, atMs: 200 });
		expect(dragPointAt(PATH, 400)).toEqual(PATH[1]);
	});
});
