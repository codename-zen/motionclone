import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runVerify, summarize } from "../src/cli/verify-run.ts";
import { readVerdictLabel } from "../src/media/verdict-label.ts";
import { verdictLabel } from "../src/report/report.ts";
import { draftSpec } from "../src/spec/draft.ts";
import { FAKE_FRAME_MS, fakeTrackCapture } from "./fake-capture.ts";

let root: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "motionclone-no-checks-"));
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

const ease = (k: number) =>
	Math.min(1, Math.max(0, (k * FAKE_FRAME_MS - 300) / 400));

describe("a verdict that checked nothing", () => {
	it("is NO CHECKS with exit code 3, not a pass", async () => {
		// Only a tracker glitch: no row survives drafting.
		const dir = await fakeTrackCapture(join(root, "glitch"), 60, (k) => ({
			sheet: { y: k === 10 ? 50 : k < 40 ? 20 : 20.6 },
		}));
		const spec = await draftSpec(dir);
		expect(spec.rows).toEqual([]);
		const run = await runVerify({ spec: dir, cloneDir: dir });
		expect(run.verdict.status).toBe("no-checks");
		expect(run.verdict.pass).toBe(false);
		expect(run.exitCode).toBe(3);
		expect(verdictLabel(run.verdict)).toMatch(/^NO CHECKS/);
		expect(run.report).toMatch(/^# motionclone verify: NO CHECKS/);
		expect(run.report).toContain("this is not a pass");
		expect(summarize(run)).toMatch(/^NO CHECKS.*\nNo motion or look row/);
		expect(summarize(run)).not.toContain("PASS");
		expect((await readVerdictLabel(dir))?.text).toBe("NO CHECKS");
	});

	it("passes once a motion row is checked", async () => {
		const dir = await fakeTrackCapture(join(root, "card"), 60, (k) => ({
			card: { x: 20 + 100 * ease(k) },
		}));
		await draftSpec(dir);
		const run = await runVerify({ spec: dir, cloneDir: dir });
		expect(run.verdict.status).toBe("pass");
		expect(run.exitCode).toBe(0);
		expect((await readVerdictLabel(dir))?.text).toBe("PASS 1/1");
	});
});
