import { readFile, writeFile } from "node:fs/promises";
import { type Metric, type RowVerdict, Verdict } from "../verify/schema.ts";

const cell = (m: Metric | undefined, digits = 0): string => {
	if (!m || m.want === null || m.got === null) return "";
	const f = (v: number) => v.toFixed(digits);
	return `${f(m.want)} / ${f(m.got)}${m.pass ? "" : " !"}`;
};

const deviation = (m: Metric | undefined): string =>
	m?.diff === null || m === undefined
		? ""
		: `${m.diff.toFixed(3)}${m.pass ? "" : " !"}`;

const escapeCell = (s: string) => s.replaceAll("|", "\\|");

function rowLine(r: RowVerdict): string {
	const m = r.metrics;
	return `| ${escapeCell(r.id)} | ${r.pass ? "pass" : "FAIL"} | ${cell(m.start)} | ${cell(m.duration)} | ${cell(m.stagger)} | ${deviation(m.easing)} | ${cell(m.overshoot, 1)} | ${cell(m.distance, 3)} |`;
}

/** Concise markdown summary of a verdict: one table row per spec row, then what to fix. */
export function renderReport(v: Verdict): string {
	const out = [
		`# motionclone verify: ${v.pass ? "PASS" : "FAIL"}`,
		"",
		`${v.summary.passed} of ${v.summary.rows} rows pass. Fidelity: ${v.fidelity}.`,
	];
	if (v.setupErrors.length > 0) {
		out.push("", "## Setup errors", "", ...v.setupErrors.map((e) => `- ${e}`));
		return `${out.join("\n")}\n`;
	}
	out.push(
		"",
		"Values are want / got; `!` marks a failing check. Times in ms, overshoot in %, easing as max progress deviation.",
		"",
		"| id | result | start | duration | stagger gap | easing | overshoot | distance |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
		...v.rows.map(rowLine),
	);
	const failing = v.rows.filter((r) => !r.pass);
	if (failing.length > 0)
		out.push(
			"",
			"## Fix",
			"",
			...failing.flatMap((r) => r.failures.map((f) => `- ${f}`)),
		);
	const p = v.pixel;
	if (p)
		out.push(
			"",
			"## Rest frames",
			"",
			p.skipped
				? `Skipped: ${p.skipped}`
				: `Mean mismatch ${((p.meanMismatch ?? 0) * 100).toFixed(2)} % (limit ${(p.threshold * 100).toFixed(1)} %, ${p.enforced ? "enforced" : "reported only"}), mean SSIM ${(p.meanSsim ?? 0).toFixed(4)} over frames ${p.frames.map((f) => f.frame).join(", ")}.`,
		);
	if (v.warnings.length > 0)
		out.push("", "## Warnings", "", ...v.warnings.map((w) => `- ${w.message}`));
	return `${out.join("\n")}\n`;
}

/** Render a verdict.json file as markdown at outPath. */
export async function writeReport(
	verdictPath: string,
	outPath: string,
): Promise<string> {
	const verdict = Verdict.parse(
		JSON.parse(await readFile(verdictPath, "utf8")),
	);
	const md = renderReport(verdict);
	await writeFile(outPath, md);
	return md;
}
