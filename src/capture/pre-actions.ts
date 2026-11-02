import type { Page } from "playwright";
import type { VirtualClock } from "./clock.ts";
import type { CaptureOptions } from "./options.ts";

/** Virtual ms the clock runs after each group of pre-trigger actions so timers, transitions and handlers take effect. */
export const PRE_SETTLE_MS = 100;
// Real ms to wait for an async preJs that is still pending after its settle time.
const PRE_JS_TIMEOUT_MS = 5000;

export const preSettleMs = (o: Pick<CaptureOptions, "preJs" | "preClick">) =>
	(o.preJs ? PRE_SETTLE_MS : 0) + (o.preClick.length > 0 ? PRE_SETTLE_MS : 0);

async function settle(
	clock: VirtualClock,
	stepMs: number,
	tAt: (v: number) => number,
): Promise<void> {
	const end = clock.now + PRE_SETTLE_MS;
	for (let v = clock.now + stepMs; v < end + stepMs; v += stepMs) {
		const to = Math.min(v, end);
		await clock.advanceTo(to, tAt(to));
	}
}

// Mouse input goes through page.mouse for the same reason as trigger clicks: real frames never come.
async function click(page: Page, selector: string, warnings: string[]) {
	const target = page.locator(selector).first();
	if ((await target.count()) === 0) {
		warnings.push(`preClick target matched nothing, skipped: ${selector}`);
		return;
	}
	const box = await target.boundingBox({ timeout: 1000 }).catch(() => null);
	if (!box) {
		warnings.push(`preClick target is not visible, skipped: ${selector}`);
		return;
	}
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Runs preJs, then each preClick in order, advancing the virtual clock PRE_SETTLE_MS after each group.
 * Everything stays under the virtual clock, so the capture remains deterministic.
 */
export async function runPreActions(
	page: Page,
	clock: VirtualClock,
	opts: Pick<CaptureOptions, "preJs" | "preClick">,
	stepMs: number,
	tAt: (v: number) => number,
	warnings: string[],
): Promise<void> {
	if (opts.preJs) {
		// The wrapper allows statements, await and return; the clock must run for timers inside it.
		const pending = page
			.evaluate(`(async () => {\n${opts.preJs}\n})()`)
			.then(() => true)
			.catch((e: Error) => {
				warnings.push(`preJs failed: ${e.message.split("\n")[0]}`);
				return true;
			});
		await settle(clock, stepMs, tAt);
		const done = await Promise.race([
			pending,
			new Promise<boolean>((ok) =>
				setTimeout(() => ok(false), PRE_JS_TIMEOUT_MS),
			),
		]);
		if (!done)
			warnings.push(
				"preJs did not finish within its settle time: it waits on a timer longer than 100 ms or on the network",
			);
	}
	if (opts.preClick.length > 0) {
		for (const selector of opts.preClick) await click(page, selector, warnings);
		await settle(clock, stepMs, tAt);
	}
}
