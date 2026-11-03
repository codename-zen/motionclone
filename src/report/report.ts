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
	const result =
		r.advisory === null
			? r.pass
				? "pass"
				: "FAIL"
			: r.pass
				? "match"
				: "differs";
	return `| ${escapeCell(r.id)} | ${result} | ${cell(m.start)} | ${cell(m.duration)} | ${cell(m.stagger)} | ${deviation(m.easing)} | ${cell(m.overshoot, 1)} | ${cell(m.distance, 3)} |`;
}

/** PASS or FAIL, with the advisory row and coverage warning counts so a PASS is never read as complete. */
export function verdictLabel(v: Verdict): string {
	const n = v.coverage?.warnings.length ?? 0;
	const { rows, advisory } = v.summary;
	const base = `${v.pass ? "PASS" : "FAIL"}${advisory ? ` (${rows - advisory} rows checked, ${advisory} advisory)` : ""}`;
	return n ? `${base} with ${n} coverage warning${n === 1 ? "" : "s"}` : base;
}

const TABLE = [
	"| id | result | start | duration | stagger gap | easing | overshoot | distance |",
	"| --- | --- | --- | --- | --- | --- | --- | --- |",
];

const table = (rows: RowVerdict[]) =>
	rows.length === 0 ? [] : [...TABLE, ...rows.map(rowLine)];

/** A titled section, intro paragraphs first; nothing at all when it has no lines. */
const section = (title: string, lines: string[], intro: string[] = []) =>
	lines.length === 0
		? []
		: ["", `## ${title}`, "", ...intro.flatMap((p) => [p, ""]), ...lines];

/** Low-confidence rows: their numbers and why the evidence is weak; they never fail the verdict. */
function advisoryLines(rows: RowVerdict[]): string[] {
	if (rows.length === 0) return [];
	return section(
		"Advisory (low confidence)",
		[
			...table(rows),
			"",
			...rows.map(
				(r) =>
					`- ${r.id}: evidence is weak: ${r.advisory}${r.pass ? "" : `. Differs: ${r.failures.join("; ")}`}`,
			),
		],
		[
			"The reference shows too little of these motions to hold a rebuild to them; they are compared but never fail the verdict.",
		],
	);
}

function partlyObservedLines(rows: RowVerdict[]): string[] {
	return rows
		.filter((r) => r.notes.length > 0)
		.map((r) => {
			const e = r.metrics.evidence;
			const gap = e
				? ` (rms gap to the visible readings ${e.got?.toFixed(3)}, spec curve ${e.want?.toFixed(3)}, allowed +${e.tol})`
				: "";
			return `- ${r.id}: ${r.notes.join("; ")}${gap}`;
		});
}

// Elements with the same rows and gaps share one line.
function notMeasuredLines(c: NonNullable<Verdict["coverage"]>): string[] {
	const groups = new Map<string, string[]>();
	for (const e of c.elements) {
		const rows = e.rows.length ? `rows ${e.rows.join(", ")}` : "held still";
		const line = `${rows}; not measured: ${e.notMeasured.join(", ")}`;
		groups.set(line, [...(groups.get(line) ?? []), e.id]);
	}
	return [...groups].map(([line, ids]) => `- ${ids.join(", ")}: ${line}`);
}

/** Concise markdown summary of a verdict: one table row per spec row, then what to fix; empty sections are left out. */
export function renderReport(v: Verdict): string {
	const out = [
		`# motionclone verify: ${verdictLabel(v)}`,
		"",
		v.summary.advisory
			? `${v.summary.passed} of ${v.summary.rows - v.summary.advisory} checked rows pass, ${v.summary.advisory} advisory. Fidelity: ${v.fidelity}.`
			: `${v.summary.passed} of ${v.summary.rows} rows pass. Fidelity: ${v.fidelity}.`,
	];
	if (v.setupErrors.length > 0) {
		out.push(
			...section(
				"Setup errors",
				v.setupErrors.map((e) => `- ${e}`),
			),
		);
		return `${out.join("\n")}\n`;
	}
	const checked = v.rows.filter((r) => r.advisory === null);
	if (checked.length > 0)
		out.push(
			"",
			"Values are want / got; `!` marks a failing check. Times in ms, overshoot in %, easing as max progress deviation.",
			"",
			...table(checked),
		);
	out.push(
		...advisoryLines(v.rows.filter((r) => r.advisory !== null)),
		...section("Partly observed", partlyObservedLines(v.rows)),
		...section(
			"Fix",
			checked
				.filter((r) => !r.pass)
				.flatMap((r) => r.failures.map((f) => `- ${f}`)),
		),
	);
	const p = v.pixel;
	if (p)
		out.push(
			...section("Rest frames", [
				p.skipped
					? `Skipped: ${p.skipped}`
					: `Mean mismatch ${((p.meanMismatch ?? 0) * 100).toFixed(2)} % (limit ${(p.threshold * 100).toFixed(1)} %, ${p.enforced ? "enforced" : "reported only"}), mean SSIM ${(p.meanSsim ?? 0).toFixed(4)} over frames ${p.frames.map((f) => f.frame).join(", ")}.`,
			]),
		);
	out.push(
		...section(
			"Warnings",
			v.warnings.map((w) => `- ${w.message}`),
		),
	);
	const c = v.coverage;
	if (c)
		out.push(
			...section(
				"Coverage warnings",
				c.warnings.map((w) => `- ${w.message}`),
				[
					"The reference changes here in ways no row checks; they do not fail the verdict, so compare them by eye.",
				],
			),
			...section("Not measured", notMeasuredLines(c), [
				`Source: ${c.source}. Visible properties listed as not measured are never compared.`,
			]),
		);
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
