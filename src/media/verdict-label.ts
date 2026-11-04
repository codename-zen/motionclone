import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Rgb } from "./image.ts";

const VerdictSummary = z.object({
	pass: z.boolean(),
	status: z.string().optional(),
	summary: z.object({ passed: z.number(), failed: z.number() }),
});

export interface VerdictLabel {
	text: string;
	color: Rgb;
}

const GREEN: Rgb = [74, 222, 128];
const RED: Rgb = [248, 113, 113];
const AMBER: Rgb = [251, 191, 36];

/** "PASS 4/4", "FAIL 1/4" or "NO CHECKS" from the verdict.json in a capture directory, null without one. */
export async function readVerdictLabel(
	dir: string,
): Promise<VerdictLabel | null> {
	let raw: string;
	try {
		raw = await readFile(join(dir, "verdict.json"), "utf8");
	} catch {
		return null;
	}
	const parsed = VerdictSummary.safeParse(JSON.parse(raw));
	if (!parsed.success) return null;
	const { pass, summary, status } = parsed.data;
	if (status === "no-checks") return { text: "NO CHECKS", color: AMBER };
	return {
		text: `${pass ? "PASS" : "FAIL"} ${summary.passed}/${summary.passed + summary.failed}`,
		color: pass ? GREEN : RED,
	};
}
