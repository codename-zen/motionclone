import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type StaticServer, serveRepo } from "./serve.ts";

const ROOT = resolve(import.meta.dirname, "..");
let server: StaticServer;
let tmp: string;
let client: Client;

beforeAll(async () => {
	server = await serveRepo();
	tmp = await mkdtemp(join(tmpdir(), "motionclone-mcp-"));
	client = new Client({ name: "test", version: "0" });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [join(ROOT, "src", "cli.ts"), "mcp"],
			cwd: ROOT,
		}),
	);
});
afterAll(async () => {
	await client.close();
	await server.close();
	await rm(tmp, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
	const r = await client.callTool({ name, arguments: args });
	const content = r.content as { type: string; text: string }[];
	return { text: content.map((c) => c.text).join("\n"), isError: r.isError };
}

const page = (name: string) => `${server.url}/fixtures/${name}/index.html`;

describe("mcp server", () => {
	it("lists the five tools", async () => {
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"capture",
			"draft_spec",
			"probe",
			"report",
			"verify",
		]);
	});

	it("reports bad input as readable tool errors", async () => {
		const r = await call("capture", { url: "x", out: join(tmp, "bad") });
		expect(r.isError).toBe(true);
		expect(r.text).toContain("--duration");
	});

	it("captures, drafts a spec and verifies compactly", async () => {
		const ref = join(tmp, "ref");
		const cap = await call("capture", {
			url: page("css-fade-up-stagger"),
			out: ref,
			duration: 1500,
			fps: 30,
			track: [".card", "h1"],
		});
		expect(cap.isError).toBeFalsy();
		expect(cap.text).toContain("captured 46 frames");

		const spec = await call("draft_spec", { captureDir: ref });
		expect(spec.text).toContain(".card[0].opacity");
		expect(spec.text.split("\n").length).toBeLessThan(40);

		const same = join(tmp, "same");
		await call("capture", {
			url: page("css-fade-up-stagger"),
			out: same,
			like: ref,
		});
		const pass = await call("verify", { spec: ref, cloneDir: same });
		expect(pass.text).toMatch(/^PASS: \d+\/\d+ rows pass/);
		expect(pass.text).toContain("verdict:");

		const wrong = join(tmp, "wrong");
		await call("capture", {
			url: page("_variants/fade-item2-late"),
			out: wrong,
			like: ref,
		});
		const fail = await call("verify", { spec: ref, cloneDir: wrong });
		expect(fail.text).toMatch(/^FAIL: \d+\/\d+ rows pass/);
		expect(fail.text).toContain(".card[2]");
		expect(fail.text.length).toBeLessThan(4000);
		const sheet = fail.text.split("\n").find((l) => l.startsWith("sheet: "));
		expect(existsSync(sheet?.slice(7) ?? "")).toBe(true);

		const rep = await call("report", { verdict: join(wrong, "verdict.json") });
		expect(rep.text).toContain("# motionclone verify: FAIL");
	});
});
