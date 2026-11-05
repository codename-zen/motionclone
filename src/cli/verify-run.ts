import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { NO_CHECKS, renderReport, verdictLabel } from "../report/report.ts";
import { type SheetInfo, writeSheets } from "../report/sheet.ts";
import { SpecFile } from "../spec/schema.ts";
import { type VerifyOptions, verifyMeasured } from "../verify/index.ts";
import {
	checkedCounts,
	countsByKind,
	statusOf,
	type Verdict,
} from "../verify/schema.ts";
import { UsageError } from "./capture-args.ts";

export interface VerifyArgs {
	spec: string;
	cloneDir: string;
	fidelity?: "motion" | "look" | "pixel";
	pixelThreshold?: number;
	reducedClone?: string;
	out?: string;
	map?: string[];
}

export interface VerifyRun {
	verdict: Verdict;
	report: string;
	verdictPath: string;
	reportPath: string;
	sheets: SheetInfo[];
	/** 0 all pass, 1 rows fail, 2 setup error, 3 no checks. */
	exitCode: 0 | 1 | 2 | 3;
}

async function readSpec(path: string): Promise<SpecFile> {
	try {
		return SpecFile.parse(JSON.parse(await readFile(path, "utf8")));
	} catch (e) {
		throw new UsageError(
			`${path} is not a valid spec.json: ${(e as Error).message}`,
		);
	}
}

const EXIT_CODES = {
	pass: 0,
	fail: 1,
	"setup-error": 2,
	"no-checks": 3,
} as const;

/** Run verify and write verdict.json, report.md and sheets for failing rows. */
export async function runVerify(a: VerifyArgs): Promise<VerifyRun> {
	const input = resolve(a.spec);
	if (!existsSync(input)) throw new UsageError(`not found: ${a.spec}`);
	const specPath = statSync(input).isDirectory()
		? join(input, "spec.json")
		: input;
	if (!existsSync(specPath))
		throw new UsageError(
			`no spec.json in ${a.spec}; run "motionclone spec" first`,
		);
	const cloneDir = resolve(a.cloneDir);
	if (!existsSync(join(cloneDir, "capture.json")))
		throw new UsageError(
			`no capture.json in ${a.cloneDir}; capture the clone first`,
		);
	const spec = await readSpec(specPath);
	const refDir = existsSync(join(dirname(specPath), "capture.json"))
		? dirname(specPath)
		: spec.meta.referenceDir;
	if (!existsSync(join(refDir, "capture.json")))
		throw new UsageError(`reference capture not found at ${refDir}`);
	const outDir = resolve(a.out ?? cloneDir);
	await mkdir(outDir, { recursive: true });
	const opts: VerifyOptions = {
		fidelity: a.fidelity,
		pixelThreshold: a.pixelThreshold,
		reducedClone: a.reducedClone,
		map: a.map,
		outDir,
	};
	const { verdict, cloneTrack } = await verifyMeasured(
		spec,
		refDir,
		cloneDir,
		opts,
	);
	const report = renderReport(verdict);
	const reportPath = join(outDir, "report.md");
	await writeFile(reportPath, report);
	const sheets = await writeSheets(
		verdict,
		join(outDir, "sheets"),
		cloneTrack ?? undefined,
	);
	return {
		verdict,
		report,
		verdictPath: join(outDir, "verdict.json"),
		reportPath,
		sheets,
		exitCode: EXIT_CODES[statusOf(verdict)],
	};
}

export function pathLines(run: VerifyRun): string[] {
	return [
		`verdict: ${run.verdictPath}`,
		`report: ${run.reportPath}`,
		...run.sheets.map((s) => `sheet: ${s.png}`),
	];
}

/** Compact text for agents: counts, failing rows with messages, paths. */
export function summarize(run: VerifyRun): string {
	const { verdict: v } = run;
	const c = checkedCounts(v);
	const kinds = countsByKind(v);
	const head = `${verdictLabel(v)}: ${c.passed}/${c.checked} rows pass${kinds ? ` (${kinds})` : ""} (fidelity ${v.fidelity})`;
	const lines = statusOf(v) === "no-checks" ? [head, NO_CHECKS] : [head];
	for (const e of v.setupErrors) lines.push(`setup error: ${e}`);
	for (const r of v.rows) {
		if (r.pass) continue;
		lines.push(
			r.advisory === null
				? `- ${r.message}`
				: `- advisory, does not fail (${r.advisory}): ${r.message}`,
		);
	}
	const p = v.pixel;
	if (p && !p.skipped && !p.pass)
		lines.push(
			`- rest frames: mean mismatch ${((p.meanMismatch ?? 0) * 100).toFixed(2)} % over limit ${(p.threshold * 100).toFixed(1)} %`,
		);
	if (v.reducedMotion) lines.push(v.reducedMotion.message);
	for (const w of v.warnings)
		if (w.rule !== "reduced-motion") lines.push(`warning: ${w.message}`);
	for (const w of v.coverage?.warnings ?? [])
		lines.push(`coverage: ${w.message}`);
	return [...lines, ...pathLines(run)].join("\n");
}
