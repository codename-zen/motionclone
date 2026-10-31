import type { Page } from "playwright";

// Arbitrary fixed epoch so Date.now() is identical across runs.
const EPOCH_MS = Date.UTC(2026, 0, 1);

// Call before navigation: JS time starts paused, so nothing runs until advanceTo().
// No install(): replaying install + pauseAt adds a random 0-1 ms real-time gap to performance.now().
export async function installClock(page: Page): Promise<void> {
	await page.clock.pauseAt(EPOCH_MS);
}

export interface VirtualClock {
	/** Virtual ms since load. */
	readonly now: number;
	/** Moves JS timers and CSS/WAAPI animations to `ms`; `t` is the trigger-relative time recorded for new animations. */
	advanceTo(ms: number, t: number): Promise<void>;
	/** Re-syncs animations at the current time, e.g. after a trigger created new transitions. */
	sync(t: number): Promise<void>;
}

export function createVirtualClock(page: Page): VirtualClock {
	let now = 0;
	const sync = (t: number) =>
		page.evaluate(
			(tt) =>
				(
					window as unknown as { __motionclone: { step(t: number): void } }
				).__motionclone.step(tt),
			t,
		);
	return {
		get now() {
			return now;
		},
		async advanceTo(ms, t) {
			if (ms > now) await page.clock.runFor(ms - now);
			now = Math.max(now, ms);
			await sync(t);
		},
		sync,
	};
}
