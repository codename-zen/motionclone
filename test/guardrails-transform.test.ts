import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureMotion } from "../src/capture/index.ts";
import { guardrails } from "../src/verify/guardrails.ts";

const page = (css: string, body: string) =>
	`<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:48px;min-height:600px}
.card{width:200px;height:100px;background:#2f6fed}
${css}</style>${body}`;

const PAGES = {
	translate: page(
		`.card{animation:slide 700ms ease-out both}
@keyframes slide{from{translate:0 40px}to{translate:0 0}}`,
		`<div class="card"></div>`,
	),
	ancestor: page(
		`.wrap{animation:rise 700ms ease-out both}
@keyframes rise{from{transform:translateY(40px)}to{transform:none}}`,
		`<div class="wrap"><div class="card"></div></div>`,
	),
	layoutAncestor: page(
		`.wrap{position:relative;animation:rise 700ms ease-out both}
@keyframes rise{from{top:40px}to{top:0}}`,
		`<div class="wrap"><div class="card"></div></div>`,
	),
};

let root: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-guard-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function warningsFor(name: keyof typeof PAGES) {
	const file = join(root, `${name}.html`);
	await writeFile(file, PAGES[name]);
	const { outDir } = await captureMotion({
		url: file,
		outDir: join(root, name),
		durationMs: 1000,
		fps: 30,
		track: [".card"],
	});
	return (await guardrails(outDir)).filter((w) => w.rule === "layout-property");
}

describe("layout guardrail", () => {
	it("accepts a card moved by the individual translate property", async () => {
		expect(await warningsFor("translate")).toEqual([]);
	});

	it("accepts a card moved by a transformed ancestor", async () => {
		expect(await warningsFor("ancestor")).toEqual([]);
	});

	it("still warns when an ancestor moves by a layout property", async () => {
		const w = await warningsFor("layoutAncestor");
		expect(w.map((x) => x.target)).toEqual([".card[0]"]);
	});
});
