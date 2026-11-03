// Builds .github/assets/demo.gif: the notch-expand fixture next to two rebuilds, with their verify results.
// Run: pnpm demo
import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { PNG } from "pngjs";
import { captureMotion } from "../src/capture/index.ts";
import { drawText, GLYPH_HEIGHT } from "../src/report/font.ts";
import { draftSpec } from "../src/spec/draft.ts";
import { verify } from "../src/verify/index.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".github", "assets", "demo.gif");
const CROP = { x: 220, y: 20, w: 760, h: 340 };
const GAP = 24;
const HEADER = 150;
const SCALE = 4;
const LINE = GLYPH_HEIGHT * SCALE + 18;
const HOLD_FRAMES = 40;

const pages = [
	{ file: "fixtures/notch-expand/index.html", label: "Reference", note: "" },
	{ file: "docs/demo/rebuild.html", label: "Your rebuild", note: "" },
	{
		file: "docs/demo/rebuild-no-blur-scale.html",
		label: "No blur, no scale",
		note: "",
	},
];

const tmp = await mkdtemp(join(tmpdir(), "motionclone-demo-"));
try {
	const options = {
		viewport: { width: 1200, height: 520 },
		fps: 30,
		durationMs: 1300,
		trigger: { type: "load" as const },
		track: [".art", ".title"],
	};
	const dirs: string[] = [];
	for (const [i, p] of pages.entries()) {
		const outDir = join(tmp, `p${i}`);
		await captureMotion({ ...options, url: join(ROOT, p.file), outDir });
		dirs.push(outDir);
	}
	const spec = await draftSpec(dirs[0] as string, { write: false });
	for (const i of [1, 2]) {
		const v = await verify(spec, dirs[0] as string, dirs[i] as string, {
			outDir: false,
		});
		const passed = v.rows.filter((r) => r.pass).length;
		(pages[i] as { note: string }).note =
			`${v.pass ? "PASS" : "FAIL"} ${passed}/${v.rows.length}`;
		console.log(pages[i]?.label, pages[i]?.note);
	}

	const frames = await Promise.all(
		dirs.map(async (d) => (await readdir(join(d, "frames"))).sort()),
	);
	const count = Math.min(...frames.map((f) => f.length));
	const width = CROP.w * 3 + GAP * 4;
	const height = HEADER + CROP.h + GAP;
	const composed = join(tmp, "composed");
	await mkdir(composed);
	for (let k = 0; k < count + HOLD_FRAMES; k++) {
		const kk = Math.min(k, count - 1);
		const canvas = new PNG({ width, height });
		canvas.data.fill(0);
		for (let i = 0; i < canvas.data.length; i += 4) canvas.data[i + 3] = 255;
		for (const [i, p] of pages.entries()) {
			const x = GAP + i * (CROP.w + GAP);
			const src = PNG.sync.read(
				await readFile(
					join(dirs[i] as string, "frames", frames[i]?.[kk] as string),
				),
			);
			PNG.bitblt(src, canvas, CROP.x, CROP.y, CROP.w, CROP.h, x, HEADER);
			drawText(canvas, p.label, x, 24, [235, 235, 240], SCALE);
			if (p.note) {
				const color: [number, number, number] = p.note.startsWith("PASS")
					? [74, 222, 128]
					: [248, 113, 113];
				drawText(canvas, p.note, x, 24 + LINE, color, SCALE);
			}
		}
		await writeFile(
			join(composed, `${String(k).padStart(4, "0")}.png`),
			PNG.sync.write(canvas),
		);
	}

	await mkdir(join(ROOT, ".github", "assets"), { recursive: true });
	const r = spawnSync(
		ffmpegPath as unknown as string,
		[
			"-v",
			"error",
			"-y",
			"-framerate",
			"30",
			"-i",
			join(composed, "%04d.png"),
			"-vf",
			"scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=sierra2_4a",
			"-loop",
			"0",
			OUT,
		],
		{ stdio: "inherit" },
	);
	if (r.status !== 0) throw new Error("ffmpeg failed");
	console.log(`wrote ${OUT}`);
} finally {
	await rm(tmp, { recursive: true, force: true });
}
