import type { PNG } from "pngjs";
import { type Clip, FrameReader } from "./clip.ts";

const CHANNEL_STEP = 6;
const STILL_FRACTION = 0.0005;
const PLATEAU_FRAMES = 3;
const MAX_PLATEAUS = 4;

function same(a: PNG, b: PNG): boolean {
	if (a.width !== b.width || a.height !== b.height) return false;
	let changed = 0;
	const allowed = a.width * a.height * STILL_FRACTION;
	for (let i = 0; i < a.data.length; i += 4) {
		if (
			Math.abs((a.data[i] as number) - (b.data[i] as number)) > CHANNEL_STEP ||
			Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)) >
				CHANNEL_STEP ||
			Math.abs((a.data[i + 2] as number) - (b.data[i + 2] as number)) >
				CHANNEL_STEP
		)
			if (++changed > allowed) return false;
	}
	return true;
}

/** Frame numbers worth a design look: the first, the last, and where a still stretch of 3+ frames begins. */
export async function restFrames(clip: Clip): Promise<number[]> {
	const reader = new FrameReader(clip);
	const keep = new Set<number>([0, clip.frames - 1]);
	let prev = await reader.read(0);
	let run = 0;
	let plateaus = 0;
	for (let i = 1; i < clip.frames; i++) {
		const cur = await reader.read(i);
		run = same(prev, cur) ? run + 1 : 0;
		if (run === PLATEAU_FRAMES - 1 && plateaus < MAX_PLATEAUS) {
			keep.add(i - run);
			plateaus++;
		}
		prev = cur;
	}
	return [...keep].sort((a, b) => a - b);
}
