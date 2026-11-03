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

const rowLine = (r: LookRowVerdict) =>
	`| ${escapeCell(r.id)} | ${r.pass ? "pass" : "FAIL"} | ${escapeCell(r.want)} | ${escapeCell(r.got ?? "")} | ${diffCell(r)} |`;

/** Fix instructions of the failing look rows and frames, for the report's fix list. */
export function lookFixes(look: LookResult | null): string[] {
	if (!look?.enforced) return [];
	const rows = look.rows.filter((r) => !r.pass).map((r) => r.message);
	const frames = (look.structure?.frames ?? [])
		.filter((f) => !f.pass)
		.map(
			(f) =>
				`layout differs on the ${f.label} rest frame (frame ${f.frame}, ${f.t} ms): blurred structure SSIM ${f.ssim.toFixed(3)} < ${look.structure?.threshold}; compare block positions, sizes and text line placement`,
		);
	return [...rows, ...frames];
}

/** The Look section: one table row per look row, then the structure score per rest frame. */
export function lookLines(look: LookResult | null): string[] {
	if (!look) return [];
	if (look.skipped) return [`Skipped: ${look.skipped}`];
	const s = look.structure;
	const structure = s
		? `Structure (SSIM of grayscale rest frames blurred by ${s.blurPx} px, min ${s.threshold}): ${s.frames.map((f) => `${f.label} frame ${f.frame} ${f.ssim.toFixed(3)}${f.pass ? "" : " !"}`).join(", ")}.`
		: "";
	return [
		`${look.summary.passed} of ${look.summary.rows} look rows pass, measured from ${look.source === "video" ? "rest-frame pixels" : "computed styles"}${look.enforced ? "" : " (reported only)"}.`,
		"",
		"| id | result | want | got | difference |",
		"| --- | --- | --- | --- | --- |",
		...look.rows.map(rowLine),
		...(structure ? ["", structure] : []),
	];
}
