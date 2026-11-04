import type { LookResult, LookRowVerdict } from "../verify/schema.ts";

const escapeCell = (s: string) => s.replaceAll("|", "\\|");

function diffCell(r: LookRowVerdict): string {
	if (r.diff === null) return "";
	const v =
		r.unit === "deltaE"
			? `ΔE ${r.diff} (max ${r.tol})`
			: r.unit === "relative"
				? `${Math.round(r.diff * 100)} % (max ${Math.round(r.tol * 100)} %)`
				: `${r.diff}x tolerance`;
	return r.pass ? v : `${v} !`;
}

const result = (r: LookRowVerdict) =>
	!r.comparable ? "not comparable" : r.pass ? "pass" : "FAIL";

const rowLine = (r: LookRowVerdict) =>
	`| ${escapeCell(r.id)} | ${result(r)} | ${escapeCell(r.want)} | ${escapeCell(r.got ?? "")} | ${diffCell(r)} |`;

/** Fix instructions of the failing look rows and frames, for the report's fix list. */
export function lookFixes(look: LookResult | null): string[] {
	if (!look?.enforced) return [];
	const rows = look.rows.filter((r) => !r.pass).map((r) => r.message);
	const s = look.structure;
	const frames = (s?.frames ?? []).flatMap((f) => {
		const at = `the ${f.label} rest frame (frame ${f.frame}, ${f.t} ms)`;
		const out: string[] = [];
		if (f.ssim < (s?.threshold ?? 0))
			out.push(
				`layout differs on ${at}: blurred structure SSIM ${f.ssim.toFixed(3)} < ${s?.threshold}; compare block positions, sizes and text line placement`,
			);
		if (f.text !== null && f.text < (s?.textThreshold ?? 0))
			out.push(
				`text lines differ on ${at}: text score ${f.text.toFixed(3)} < ${s?.textThreshold}; compare type sizes and where each line sits`,
			);
		return out;
	});
	return [...rows, ...frames];
}

/** Rows the clone's content could not be compared with: listed, never failing. */
function notComparableLines(rows: readonly LookRowVerdict[]): string[] {
	const list = rows.filter((r) => !r.comparable);
	return list.length
		? [
				"",
				"Not comparable (other content in the clone; these rows never fail, compare them by eye):",
				"",
				...list.map((r) => `- ${r.message}`),
			]
		: [];
}

/** The Look section: one table row per look row, then the structure score per rest frame. */
export function lookLines(look: LookResult | null): string[] {
	if (!look) return [];
	if (look.skipped) return [`Skipped: ${look.skipped}`];
	const s = look.structure;
	const textOf = (f: NonNullable<typeof s>["frames"][number]) =>
		f.text === null ? "" : `, text ${f.text.toFixed(3)}`;
	const structure = s
		? `Structure (SSIM of grayscale rest frames blurred by ${s.blurPx} px, min ${s.threshold}; text score of the text lines, min ${s.textThreshold ?? "none"}): ${s.frames.map((f) => `${f.label} frame ${f.frame} ${f.ssim.toFixed(3)}${textOf(f)}${f.pass ? "" : " !"}`).join(", ")}.`
		: "";
	return [
		`${look.summary.passed} of ${look.summary.rows} look rows pass${look.summary.notComparable ? ` (${look.summary.notComparable} not comparable)` : ""}, measured from ${look.source === "video" ? "rest-frame pixels" : "computed styles"}${look.enforced ? "" : " (reported only)"}.`,
		"",
		"| id | result | want | got | difference |",
		"| --- | --- | --- | --- | --- |",
		...look.rows.map(rowLine),
		...notComparableLines(look.rows),
		...(structure ? ["", structure] : []),
	];
}
