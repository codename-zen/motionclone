import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrackFrame } from "../capture/types.ts";
import type { LookRegion } from "./pixels.ts";
import { LOOK_FILE, LookFile } from "./schema.ts";

const json = (value: unknown): string =>
	`${JSON.stringify(value, null, "\t")}\n`;

export const writeLook = (dir: string, look: LookFile) =>
	writeFile(join(dir, LOOK_FILE), json(LookFile.parse(look)));

/** look.json of a capture, or null for captures made before it existed. */
export async function readLook(dir: string): Promise<LookFile | null> {
	try {
		return LookFile.parse(
			JSON.parse(await readFile(join(dir, LOOK_FILE), "utf8")),
		);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

/** Every tracked element's box on one frame, keyed like spec rows: "sel[i]". */
export const regionsAt = (frame: TrackFrame | undefined): LookRegion[] =>
	Object.entries(frame?.elements ?? {}).flatMap(([sel, list]) =>
		list
			.filter((e) => e.w > 0 && e.h > 0)
			.map((e) => ({
				key: `${sel}[${e.index}]`,
				box: { x: e.x, y: e.y, w: e.w, h: e.h },
			})),
	);
