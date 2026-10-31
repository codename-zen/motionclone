import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEME = /^[a-z][a-z\d+.-]+:/i;
const WINDOWS_PATH = /^([a-z]:[/]|\\)/i;

// A single-letter "scheme" is a drive letter, so schemes need two or more characters.
export function toUrl(input: string): string {
	if (WINDOWS_PATH.test(input))
		return pathToFileURL(input, { windows: true }).href;
	if (SCHEME.test(input)) return input;
	return pathToFileURL(resolve(input)).href;
}
