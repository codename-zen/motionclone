import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
};

export interface StaticServer {
	url: string;
	close(): Promise<void>;
}

// Serves the repo root so fixtures can load libraries from node_modules.
export async function serveRepo(): Promise<StaticServer> {
	const server: Server = createServer((req, res) => {
		const path = normalize(
			decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname),
		);
		let file = join(ROOT, path);
		if (!file.startsWith(ROOT)) {
			res.writeHead(403).end();
			return;
		}
		try {
			if (statSync(file).isDirectory()) file = join(file, "index.html");
			statSync(file);
		} catch {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, {
			"content-type": TYPES[extname(file)] ?? "application/octet-stream",
		});
		createReadStream(file).pipe(res);
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise((ok) => server.close(() => ok())),
	};
}
