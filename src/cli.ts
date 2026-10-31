#!/usr/bin/env node
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { type CaptureArgs, UsageError } from "./cli/capture-args.ts";
import { captureLines } from "./cli/capture-run.ts";
import { HELP, MAIN_HELP } from "./cli/help.ts";
import { pathLines, runVerify } from "./cli/verify-run.ts";
import { probeLines } from "./cli/video-args.ts";
import { writeReport } from "./report/report.ts";
import { draftSpec } from "./spec/draft.ts";
import { easingLabel } from "./spec/easing.ts";
import { VERSION } from "./version.ts";

const out = (text: string) => process.stdout.write(`${text}\n`);

const CAPTURE_FLAGS = {
	out: { type: "string" },
	like: { type: "string" },
	viewport: { type: "string" },
	fps: { type: "string" },
	duration: { type: "string" },
	trigger: { type: "string" },
	target: { type: "string" },
	"scroll-to": { type: "string" },
	track: { type: "string" },
	clip: { type: "string" },
	selector: { type: "string" },
	pad: { type: "string" },
	"pre-roll": { type: "string" },
	"wait-before": { type: "string" },
	"color-scheme": { type: "string" },
	"reduced-motion": { type: "boolean" },
	"storage-state": { type: "string" },
	"cdp-url": { type: "string" },
	seed: { type: "string" },
	start: { type: "string" },
	end: { type: "string" },
	crop: { type: "string" },
	width: { type: "string" },
	"css-scale": { type: "string" },
	region: { type: "string", multiple: true },
	"auto-regions": { type: "boolean" },
} as const;

const VERIFY_FLAGS = {
	fidelity: { type: "string" },
	"pixel-threshold": { type: "string" },
	"reduced-clone": { type: "string" },
	out: { type: "string" },
	json: { type: "boolean" },
	map: { type: "string", multiple: true },
} as const;

const num = (flag: string, v: string | undefined): number | undefined => {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (v.trim() === "" || !Number.isFinite(n))
		throw new UsageError(`--${flag}: "${v}" is not a number`);
	return n;
};

function oneOf<T extends string>(
	flag: string,
	v: string | undefined,
	allowed: readonly T[],
): T | undefined {
	if (v !== undefined && !allowed.includes(v as T))
		throw new UsageError(
			`--${flag}: "${v}" must be one of ${allowed.join(", ")}`,
		);
	return v as T | undefined;
}

function parse<
	O extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>,
>(args: string[], options: O) {
	return parseArgs({
		args,
		options: { help: { type: "boolean", short: "h" }, ...options },
		allowPositionals: true,
	});
}

function exactly(list: string[], count: number, usage: string): string[] {
	if (list.length !== count)
		throw new UsageError(
			`expected ${count} argument${count === 1 ? "" : "s"}: ${usage}`,
		);
	return list;
}

function help(command?: string): number {
	out((command ? HELP[command] : MAIN_HELP) as string);
	return 0;
}

async function capture(args: string[]): Promise<number> {
	const { values: v, positionals: p } = parse(args, CAPTURE_FLAGS);
	if (v.help) return help("capture");
	const [url] = exactly(p, 1, "motionclone capture <url|path|video> --out <dir>");
	if (!v.out) throw new UsageError("--out <dir> is required");
	const input: CaptureArgs = {
		url: url as string,
		out: v.out,
		like: v.like,
		viewport: v.viewport,
		fps: num("fps", v.fps),
		duration: num("duration", v.duration),
		trigger: oneOf("trigger", v.trigger, [
			"load",
			"none",
			"hover",
			"leave",
			"click",
			"scroll",
		]),
		target: v.target,
		scrollTo: v["scroll-to"],
		track: v.track
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		clip: v.clip,
		selector: v.selector,
		pad: num("pad", v.pad),
		preRoll: num("pre-roll", v["pre-roll"]),
		waitBefore: num("wait-before", v["wait-before"]),
		colorScheme: oneOf("color-scheme", v["color-scheme"], [
			"light",
			"dark",
			"no-preference",
		]),
		reducedMotion: v["reduced-motion"],
		storageState: v["storage-state"],
		cdpUrl: v["cdp-url"],
		seed: num("seed", v.seed),
		start: v.start,
		end: v.end,
		crop: v.crop,
		width: num("width", v.width),
		cssScale: num("css-scale", v["css-scale"]),
		regions: v.region,
		autoRegions: v["auto-regions"],
	};
	for (const line of await captureLines(input)) out(line);
	return 0;
}

async function probe(args: string[]): Promise<number> {
	const { values: v, positionals: p } = parse(args, {});
	if (v.help) return help("probe");
	const [file] = exactly(p, 1, "motionclone probe <video|gif>") as [string];
	for (const line of await probeLines(file)) out(line);
	return 0;
}

async function spec(args: string[]): Promise<number> {
	const { values: v, positionals: p } = parse(args, {});
	if (v.help) return help("spec");
	const [dir] = exactly(p, 1, "motionclone spec <captureDir>") as [string];
	const s = await draftSpec(dir);
	out(`${s.rows.length} motion rows, ${s.still.length} still elements`);
	for (const r of s.rows)
		out(
			`${r.id}  start ${r.startMs} ms  duration ${r.durationMs} ms  ${easingLabel(r.easing)}  ${r.source}/${r.confidence}`,
		);
	out(`spec: ${join(dir, "spec.json")}`);
	return 0;
}

async function verifyCmd(args: string[]): Promise<number> {
	const { values: v, positionals: p } = parse(args, VERIFY_FLAGS);
	if (v.help) return help("verify");
	const [specArg, cloneDir] = exactly(
		p,
		2,
		"motionclone verify <spec.json|captureDir> <cloneDir>",
	) as [string, string];
	const run = await runVerify({
		spec: specArg,
		cloneDir,
		fidelity: oneOf("fidelity", v.fidelity, ["motion", "pixel"]),
		pixelThreshold: num("pixel-threshold", v["pixel-threshold"]),
		reducedClone: v["reduced-clone"],
		out: v.out,
		map: v.map,
	});
	if (v.json) out(JSON.stringify(run.verdict, null, "\t"));
	else out(`${run.report.trimEnd()}\n\n${pathLines(run).join("\n")}`);
	return run.exitCode;
}

async function report(args: string[]): Promise<number> {
	const { values: v, positionals: p } = parse(args, {});
	if (v.help) return help("report");
	const [file] = exactly(p, 1, "motionclone report <verdict.json>") as [string];
	out((await writeReport(file, join(dirname(file), "report.md"))).trimEnd());
	return 0;
}

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || ["--help", "-h", "help"].includes(command)) return help();
	if (command === "--version" || command === "-v") {
		out(VERSION);
		return 0;
	}
	switch (command) {
		case "capture":
			return capture(rest);
		case "probe":
			return probe(rest);
		case "spec":
			return spec(rest);
		case "verify":
			return verifyCmd(rest);
		case "report":
			return report(rest);
		case "mcp": {
			if (rest.includes("--help") || rest.includes("-h")) return help("mcp");
			await (await import("./mcp.ts")).serveMcp();
			return -1;
		}
		default:
			throw new UsageError(
				`unknown command "${command}"; run motionclone --help`,
			);
	}
}

function describe(e: unknown): string {
	if (e instanceof ZodError)
		return e.issues
			.map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
			.join("\n");
	return e instanceof Error ? e.message : String(e);
}

try {
	const code = await main(process.argv.slice(2));
	if (code >= 0) process.exitCode = code;
} catch (e) {
	process.stderr.write(`error: ${describe(e)}\n`);
	process.exitCode = 2;
}
