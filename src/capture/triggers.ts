import type { Page } from "playwright";
import type { TriggerOptions } from "./options.ts";

export interface TriggerAction {
	/** Trigger-relative ms at which the action runs. */
	atMs: number;
	run(): Promise<void>;
}

async function center(
	page: Page,
	selector: string,
	at?: { x: number; y: number },
) {
	const box = await page.locator(selector).first().boundingBox();
	if (!box)
		throw new Error(`trigger target matched no visible element: ${selector}`);
	return at
		? { x: box.x + at.x, y: box.y + at.y }
		: { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const RENDER_TIMEOUT_MS = 5000;

// Scroll timelines and scroll events catch up only at the next rendering update, which runs in real time.
// "instant" overrides CSS smooth scrolling, which would also animate in real time.
async function scrollAndRender(page: Page, y: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const rendered = page.evaluate(
		(yy) =>
			new Promise<void>((done) => {
				window.scrollTo({ top: yy, left: 0, behavior: "instant" });
				// The first observation is delivered after the next rendering update.
				new IntersectionObserver((_, o) => {
					o.disconnect();
					done();
				}).observe(document.documentElement);
			}),
		y,
	);
	const timeout = new Promise<never>((_, fail) => {
		timer = setTimeout(
			() =>
				fail(
					new Error(
						`page rendered no frame within ${RENDER_TIMEOUT_MS} ms after scrolling to ${y}px; is the tab hidden?`,
					),
				),
			RENDER_TIMEOUT_MS,
		);
	});
	try {
		await Promise.race([rendered, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

// Runs before the wait so a "leave" starts from a settled hover state.
export async function prepareTrigger(
	page: Page,
	trigger: TriggerOptions,
): Promise<void> {
	if (trigger.type === "leave") {
		const p = await center(page, trigger.target);
		await page.mouse.move(p.x, p.y);
	}
}

// Mouse input goes through page.mouse, not locator actions, because actionability checks wait on real frames.
export async function planTrigger(
	page: Page,
	trigger: TriggerOptions,
	viewport: { width: number },
): Promise<TriggerAction[]> {
	switch (trigger.type) {
		case "load":
		case "none":
			return [];
		case "hover": {
			const p = await center(page, trigger.target, trigger.at);
			return [{ atMs: 0, run: () => page.mouse.move(p.x, p.y) }];
		}
		case "leave": {
			const box = await page.locator(trigger.target).first().boundingBox();
			const outside =
				box && box.x < 1 && box.y < 1
					? { x: viewport.width - 1, y: 0 }
					: { x: 0, y: 0 };
			return [{ atMs: 0, run: () => page.mouse.move(outside.x, outside.y) }];
		}
		case "click": {
			const p = await center(page, trigger.target);
			return [{ atMs: 0, run: () => page.mouse.click(p.x, p.y) }];
		}
		case "scroll": {
			const from = await page.evaluate(() => window.scrollY);
			const to =
				trigger.toPx ??
				(await page.evaluate((sel) => {
					const el = document.querySelector(sel);
					if (!el) throw new Error(`scroll target matched nothing: ${sel}`);
					return el.getBoundingClientRect().top + window.scrollY;
				}, trigger.toSelector as string));
			return Array.from({ length: trigger.steps }, (_, i) => {
				const k = (i + 1) / trigger.steps;
				const y = Math.round(from + (to - from) * k);
				return {
					atMs: trigger.ms * (i / Math.max(1, trigger.steps - 1)),
					run: () => scrollAndRender(page, y),
				};
			});
		}
	}
}
