import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type StaticServer, serveRepo } from "./serve.ts";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src", "cli.ts");
const DIST = join(ROOT, "dist", "cli.js");
const TRACK = ".card, h1";

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

const cli =
	(entry: string) =>
	async (...args: string[]): Promise<Result> => {
		try {
			const r = await run(process.execPath, [entry, ...args], {
				cwd: ROOT,
				timeout: 120_000,
			});
			return { code: 0, ...r };
		} catch (e) {
			const err = e as { code: number; stdout: string; stderr: string };
			return { code: err.code, stdout: err.stdout, stderr: err.stderr };
		}
	};

let server: StaticServer;
let tmp: string;
beforeAll(async () => {
	server = await serveRepo();
	tmp = await mkdtemp(join(tmpdir(), "motionclone-cli-"));
});
afterAll(async () => {
	await server.close();
	await rm(tmp, { recursive: true, force: true });
});

const page = (name: string) => `${server.url}/fixtures/${name}/index.html`;

function suite(label: string, entry: string, runIf: boolean) {
	describe.skipIf(!runIf)(`cli (${label})`, () => {
		const motionclone = cli(entry);
		const dir = (n: string) => join(tmp, `${label}-${n}`);

		it("prints help and the package version", async () => {
			const help = await motionclone("--help");
			expect(help.code).toBe(0);
			for (const c of ["capture", "spec", "verify", "report", "mcp"])
				expect(help.stdout).toContain(c);
			expect((await motionclone("verify", "--help")).stdout).toContain(
				"--fidelity",
			);
			const pkg = JSON.parse(
				await readFile(join(ROOT, "package.json"), "utf8"),
			);
			expect((await motionclone("--version")).stdout.trim()).toBe(pkg.version);
		});

		it("rejects bad input with exit 2 and a readable message", async () => {
			const unknownFlag = await motionclone(
				"capture",
				"x",
				"--out",
				"o",
				"--nope",
			);
			expect(unknownFlag.code).toBe(2);
			expect(unknownFlag.stderr).toMatch(/^error: .*--nope/);
			const notNumber = await motionclone(
				"capture",
				"x",
				"--out",
				"o",
				"--fps",
				"fast",
			);
			expect(notNumber.code).toBe(2);
			expect(notNumber.stderr).toContain('--fps: "fast" is not a number');
			const noDuration = await motionclone("capture", "x", "--out", dir("bad"));
			expect(noDuration.stderr).toContain("--duration");
			const noTarget = await motionclone(
				"capture",
				"x",
				"--out",
				"o",
				"--duration",
				"100",
				"--trigger",
				"hover",
			);
			expect(noTarget.stderr).toContain("--trigger hover needs --target");
			expect((await motionclone("nope")).code).toBe(2);
			const missing = await motionclone(
				"verify",
				join(tmp, "none"),
				join(tmp, "none2"),
			);
			expect(missing.code).toBe(2);
			expect(missing.stderr).toContain("not found");
		});

		it("captures, drafts a spec and verifies a --like clone and a wrong variant", async () => {
			const ref = dir("ref");
			const flags = ["--duration", "1500", "--fps", "30", "--track", TRACK];
			const cap = await motionclone(
				"capture",
				page("css-fade-up-stagger"),
				"--out",
				ref,
				...flags,
			);
			expect(cap.code, cap.stderr).toBe(0);
			expect(cap.stdout).toContain("captured 46 frames");

			const spec = await motionclone("spec", ref);
			expect(spec.code, spec.stderr).toBe(0);
			expect(spec.stdout).toContain(".card[0].opacity");
			expect(existsSync(join(ref, "spec.json"))).toBe(true);

			const same = dir("same");
			const like = await motionclone(
				"capture",
				page("css-fade-up-stagger"),
				"--like",
				ref,
				"--out",
				same,
			);
			expect(like.code, like.stderr).toBe(0);
			const refOpts = JSON.parse(
				await readFile(join(ref, "capture.json"), "utf8"),
			).options;
			const likeOpts = JSON.parse(
				await readFile(join(same, "capture.json"), "utf8"),
			).options;
			expect({ ...likeOpts, url: 0, outDir: 0 }).toEqual({
				...refOpts,
				url: 0,
				outDir: 0,
			});

			const pass = await motionclone("verify", ref, same);
			expect(pass.code, pass.stdout).toBe(0);
			expect(pass.stdout).toContain("# motionclone verify: PASS");
			expect(existsSync(join(same, "verdict.json"))).toBe(true);
			expect(existsSync(join(same, "report.md"))).toBe(true);

			const wrong = dir("wrong");
			await motionclone(
				"capture",
				page("_variants/fade-item2-late"),
				"--like",
				ref,
				"--out",
				wrong,
			);
			const fail = await motionclone("verify", join(ref, "spec.json"), wrong);
			expect(fail.code, fail.stdout).toBe(1);
			expect(fail.stdout).toContain("# motionclone verify: FAIL");
			expect(fail.stdout).toContain(".card[2]");
			expect(existsSync(join(wrong, "sheets"))).toBe(true);

			const json = await motionclone(
				"verify",
				ref,
				wrong,
				"--json",
				"--out",
				dir("out"),
			);
			expect(json.code).toBe(1);
			expect(JSON.parse(json.stdout).summary.failed).toBeGreaterThan(0);
			const rep = await motionclone("report", join(dir("out"), "verdict.json"));
			expect(rep.stdout).toContain("# motionclone verify: FAIL");
		});
	});
}

suite("src", SRC, true);
suite("dist", DIST, existsSync(DIST));
