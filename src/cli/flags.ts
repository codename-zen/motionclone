import { parseArgs } from "node:util";
import { UsageError } from "./capture-args.ts";

export const CAPTURE_FLAGS = {
	out: { type: "string" },
	like: { type: "string" },
	viewport: { type: "string" },
	fps: { type: "string" },
	duration: { type: "string" },
	trigger: { type: "string" },
	target: { type: "string" },
	"scroll-to": { type: "string" },
	drag: { type: "string" },
	track: { type: "string" },
	clip: { type: "string" },
	selector: { type: "string" },
	pad: { type: "string" },
	"pre-roll": { type: "string" },
	"wait-before": { type: "string" },
	"pre-js": { type: "string" },
	"pre-click": { type: "string", multiple: true },
	"color-scheme": { type: "string" },
	"reduced-motion": { type: "boolean" },
	"storage-state": { type: "string" },
	"cdp-url": { type: "string" },
	seed: { type: "string" },
	start: { type: "string" },
	end: { type: "string" },
	crop: { type: "string" },
	width: { type: "string" },
	"css-scale": { type: "string" },
	region: { type: "string", multiple: true },
	"auto-regions": { type: "boolean" },
} as const;

export const VERIFY_FLAGS = {
	fidelity: { type: "string" },
	"pixel-threshold": { type: "string" },
	"reduced-clone": { type: "string" },
	out: { type: "string" },
	json: { type: "boolean" },
	map: { type: "string", multiple: true },
} as const;

export const SIDE_BY_SIDE_FLAGS = {
	out: { type: "string" },
	labels: { type: "string" },
	from: { type: "string" },
	to: { type: "string" },
	fps: { type: "string" },
	width: { type: "string" },
	crop: { type: "string", multiple: true },
	offset: { type: "string" },
	hold: { type: "string" },
} as const;

export const num = (
	flag: string,
	v: string | undefined,
): number | undefined => {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (v.trim() === "" || !Number.isFinite(n))
		throw new UsageError(`--${flag}: "${v}" is not a number`);
	return n;
};

export function oneOf<T extends string>(
	flag: string,
	v: string | undefined,
	allowed: readonly T[],
): T | undefined {
	if (v !== undefined && !allowed.includes(v as T))
		throw new UsageError(
			`--${flag}: "${v}" must be one of ${allowed.join(", ")}`,
		);
	return v as T | undefined;
}

export function parse<
	O extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>,
>(args: string[], options: O) {
	return parseArgs({
		args,
		options: { help: { type: "boolean", short: "h" }, ...options },
		allowPositionals: true,
	});
}

export function exactly(
	list: string[],
	count: number,
	usage: string,
): string[] {
	if (list.length !== count)
		throw new UsageError(
			`expected ${count} argument${count === 1 ? "" : "s"}: ${usage}`,
		);
	return list;
}
