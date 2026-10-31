import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CaptureArgs } from "./cli/capture-args.ts";
import { captureLines } from "./cli/capture-run.ts";
import { runVerify, summarize } from "./cli/verify-run.ts";
import { probeLines } from "./cli/video-args.ts";
import { writeReport } from "./report/report.ts";
import { draftSpec } from "./spec/draft.ts";
import { easingLabel } from "./spec/easing.ts";
import { VERSION } from "./version.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });

// Tool failures go back as readable text so the agent can fix the input and retry.
async function guarded(fn: () => Promise<string>): Promise<Result> {
	try {
		return text(await fn());
	} catch (e) {
		const msg =
			e instanceof z.ZodError
				? e.issues
						.map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
						.join("\n")
				: e instanceof Error
					? e.message
					: String(e);
		return { ...text(`error: ${msg}`), isError: true };
	}
}

export function createServer(): McpServer {
	const server = new McpServer({ name: "motionclone", version: VERSION });

	server.registerTool(
		"capture",
		{
			description:
				'Record a page\'s motion (frames and element tracks) into a directory. Use like=<reference capture dir> when capturing the clone so both are recorded the same way. A local .mp4, .mov, .webm or .gif path as url records a video instead: use start, end, crop, width, cssScale and regions ("card[0]=x,y,w,h") with it, and probe it first.',
			inputSchema: CaptureArgs.shape,
		},
		(args) => guarded(async () => (await captureLines(args)).join("\n")),
	);

	server.registerTool(
		"probe",
		{
			description:
				"Read the size, frame rate, duration and codec of a recording or gif before capturing it.",
			inputSchema: { file: z.string().describe("Path to the video or gif") },
		},
		({ file }) => guarded(async () => (await probeLines(file)).join("\n")),
	);

	server.registerTool(
		"draft_spec",
		{
			description:
				"Draft spec.json from a reference capture directory and list its rows.",
			inputSchema: {
				captureDir: z.string().describe("Reference capture directory"),
			},
		},
		({ captureDir }) =>
			guarded(async () => {
				const s = await draftSpec(captureDir);
				return [
					`${s.rows.length} motion rows, ${s.still.length} still elements`,
					...s.rows.map(
						(r) =>
							`${r.id}: start ${r.startMs} ms, duration ${r.durationMs} ms, ${easingLabel(r.easing)} (${r.source}, ${r.confidence})`,
					),
					`spec: ${join(captureDir, "spec.json")}`,
				].join("\n");
			}),
	);

	server.registerTool(
		"verify",
		{
			description:
				"Check a clone capture against the spec. Returns pass/fail counts, one message per failing row, and the verdict, report and sheet paths. View a sheet only for a failing row.",
			inputSchema: {
				spec: z
					.string()
					.describe("spec.json path or the reference capture directory"),
				cloneDir: z.string().describe("Clone capture directory"),
				fidelity: z.enum(["motion", "pixel"]).optional(),
				pixelThreshold: z.number().optional(),
				reducedClone: z
					.string()
					.optional()
					.describe("Clone capture taken with reducedMotion on"),
				out: z
					.string()
					.optional()
					.describe("Output directory, default cloneDir"),
				map: z
					.array(z.string())
					.optional()
					.describe(
						'Video reference: rename clone selectors to region names, "card=.card" for all indexes or "card[2]=.x[0]" for one',
					),
			},
		},
		(args) => guarded(async () => summarize(await runVerify(args))),
	);

	server.registerTool(
		"report",
		{
			description: "Render a verdict.json as a markdown report.",
			inputSchema: { verdict: z.string().describe("verdict.json path") },
		},
		({ verdict }) =>
			guarded(async () =>
				(
					await writeReport(verdict, join(dirname(verdict), "report.md"))
				).trimEnd(),
			),
	);

	return server;
}

export async function serveMcp(): Promise<void> {
	await createServer().connect(new StdioServerTransport());
}
