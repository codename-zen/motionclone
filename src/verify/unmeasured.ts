import type { TrackedElement } from "../capture/types.ts";
import type { Track } from "../measure/elements.ts";
import { elementKey } from "../spec/motion.ts";
import type { CoverageWarning } from "./schema.ts";

// Tracked styles that change what is painted but never become rows.
const STYLES: [string, (e: TrackedElement) => string][] = [
	["colour", (e) => e.color],
	["background", (e) => e.backgroundColor],
	["shadow", (e) => e.boxShadow],
	["clip-path", (e) => e.clipPath],
	// Blur is a row; any other filter function is not.
	["filter", (e) => e.filter.replace(/blur\([^)]*\)/g, "").trim() || "none"],
];

/** Elements whose colour, background, shadow, clip-path or non-blur filter changes in the reference. */
export function unmeasuredChanges(track: Track): CoverageWarning[] {
	const out: CoverageWarning[] = [];
	const seen = new Map<string, { last: number; prev: string[] }>();
	const changes = new Map<string, Map<string, { from: number; to: number }>>();
	for (let i = 0; i < track.frames.length; i++) {
		const f = track.frames[i];
		if (!f) continue;
		for (const [sel, list] of Object.entries(f.elements))
			for (const e of list) {
				const key = elementKey(sel, e.index);
				const now = STYLES.map(([, read]) => read(e));
				const before = seen.get(key);
				if (before)
					STYLES.forEach(([name], k) => {
						if (now[k] === before.prev[k]) return;
						const byName = changes.get(key) ?? new Map();
						const span = byName.get(name);
						byName.set(name, { from: span?.from ?? before.last, to: f.t });
						changes.set(key, byName);
					});
				seen.set(key, { last: f.t, prev: now });
			}
	}
	for (const [key, byName] of changes)
		for (const [name, span] of byName)
			out.push({
				rule: "unmeasured-property",
				target: key,
				fromMs: span.from,
				toMs: span.to,
				message: `${key}: ${name} changes from ${Math.round(span.from)} to ${Math.round(span.to)} ms, which motionclone does not measure; compare it by eye`,
			});
	return out;
}
