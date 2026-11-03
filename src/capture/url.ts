import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEME = /^[a-z][a-z\d+.-]+:/i;
const WINDOWS_PATH = /^([a-z]:[\\/]|\\)/i;

// A single-letter "scheme" is a drive letter, so schemes need two or more characters.
export function toUrl(input: string): string {
	if (!WINDOWS_PATH.test(input) && SCHEME.test(input)) return input;
	// "index.html#demo" and "page.html?x=1" are a file plus a suffix, unless a file has that exact name.
	const cut = existsSync(input) ? -1 : input.search(/[?#]/);
	const path = cut < 0 ? input : input.slice(0, cut);
	const suffix = cut < 0 ? "" : input.slice(cut);
	const href = WINDOWS_PATH.test(path)
		? pathToFileURL(path, { windows: true }).href
		: pathToFileURL(resolve(path)).href;
	return href + suffix;
}
