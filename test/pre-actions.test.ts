import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { preJsOf, runCapture } from "../src/cli/capture-args.ts";
import { readTrack } from "../src/measure/elements.ts";
import { readCaptureFile } from "../src/spec/capture-file.ts";

const PAGE = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:48px;min-height:600px}
.box{width:200px;height:100px;background:rgb(0,0,255);transition:background 50ms}
.ready .box{background:rgb(255,0,0)}
.banner{position:fixed;inset:auto 0 0 0;height:120px;background:#222}
</style>
<div class="box"></div>
<div class="banner"><button style="width:120px;height:40px" onclick="this.parentElement.remove()">Accept</button></div>`;

let root: string;
let page: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-pre-"));
	page = join(root, "page.html");
	await writeFile(page, PAGE);
});
afterAll(() => rm(root, { recursive: true, force: true }));

const base = (name: string) => ({
	url: page,
	outDir: join(root, name),
	durationMs: 300,
	fps: 30,
	track: [".banner", ".box"],
	trigger: { type: "none" as const },
});

const frame0 = async (dir: string) => (await readTrack(dir)).frames[0];

describe("pre-trigger actions", () => {
	it("keeps the banner in frame 0 without them", async () => {
		const { outDir } = await captureMotion(base("plain"));
		expect((await frame0(outDir))?.elements[".banner"]).toHaveLength(1);
	});

	it("preClick dismisses the banner before frame 0", async () => {
		const s = await captureMotion({
			...base("click"),
			preClick: [".banner button", ".missing"],
		});
		expect((await frame0(s.outDir))?.elements[".banner"]).toEqual([]);
		expect(s.warnings).toEqual([
			"preClick target matched nothing, skipped: .missing",
		]);
	});

	it("preJs runs statements and its changes are settled by frame 0", async () => {
		const s = await captureMotion({
			...base("js"),
			preJs: "await Promise.resolve(); document.body.classList.add('ready')",
		});
		expect(
			(await frame0(s.outDir))?.elements[".box"]?.[0]?.backgroundColor,
		).toBe("rgb(255, 0, 0)");
	});

	it("reports a failing preJs as a warning", async () => {
		const s = await captureMotion({ ...base("bad"), preJs: "nope()" });
		expect(s.warnings.join("\n")).toContain("preJs failed");
	});

	it("is recorded and reused by --like, and stays deterministic", async () => {
		const opts = {
			...base("ref"),
			preJs: "document.body.classList.add('ready')",
			preClick: [".banner button"],
		};
		const ref = await captureMotion(opts);
		const file = await readCaptureFile(ref.outDir);
		expect(file.options.preJs).toBe(opts.preJs);
		expect(file.options.preClick).toEqual([".banner button"]);

		const like = await runCapture({
			url: page,
			out: join(root, "like"),
			like: ref.outDir,
		});
		const reused = await readCaptureFile(like.outDir);
		expect(reused.options.preJs).toBe(opts.preJs);
		expect(reused.options.preClick).toEqual([".banner button"]);
		expect((await frame0(like.outDir))?.elements[".banner"]).toEqual([]);
		expect(await readFile(join(like.outDir, "track.json"), "utf8")).toBe(
			await readFile(join(ref.outDir, "track.json"), "utf8"),
		);
		for (const f of ["0000", "0005"]) {
			const name = join("frames", `${f}.png`);
			expect(await readFile(join(like.outDir, name))).toEqual(
				await readFile(join(ref.outDir, name)),
			);
		}
	});
});

describe("preJsOf", () => {
	it("reads an existing .js file and passes other text through", async () => {
		const file = join(root, "dismiss.js");
		await writeFile(file, "document.title = 'x'");
		expect(preJsOf(file)).toBe("document.title = 'x'");
		expect(preJsOf("missing.js")).toBe("missing.js");
		expect(preJsOf("document.title = 'y'")).toBe("document.title = 'y'");
		expect(preJsOf(undefined)).toBeUndefined();
	});
});
