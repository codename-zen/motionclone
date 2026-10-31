import { createRequire } from "node:module";

// src/ and dist/ both sit one level below package.json.
export const VERSION: string = (
	createRequire(import.meta.url)("../package.json") as { version: string }
).version;
