import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "playwright";
import type { CaptureOptions } from "./options.ts";

export interface Session {
	browser: Browser;
	context: BrowserContext;
	page: Page;
	close(): Promise<void>;
}

/**
 * Grayscale text antialiasing on every OS: Windows draws subpixel (LCD) text by default, whose coloured fringes
 * shift measured text colours (near-black read as #1f1940) and differ from captures made elsewhere.
 */
export const LAUNCH_ARGS = ["--disable-lcd-text"];

export async function openSession(
	opts: CaptureOptions,
	warnings: string[],
): Promise<Session> {
	const media = {
		colorScheme: opts.colorScheme ?? null,
		reducedMotion: opts.reducedMotion ?? null,
	};
	if (opts.cdpUrl) {
		const browser = await chromium.connectOverCDP(opts.cdpUrl);
		const context = browser.contexts()[0] ?? (await browser.newContext());
		if (opts.deviceScaleFactor !== 1)
			warnings.push("deviceScaleFactor is ignored when connecting over cdpUrl");
		if (opts.storageState)
			warnings.push(
				"storageState is ignored when connecting over cdpUrl; the running profile is used",
			);
		const page = await context.newPage();
		await page.setViewportSize(opts.viewport);
		await page.emulateMedia(media);
		return {
			browser,
			context,
			page,
			close: async () => {
				await page.close();
				await browser.close();
			},
		};
	}
	const browser = await chromium.launch({ args: LAUNCH_ARGS });
	const context = await browser.newContext({
		viewport: opts.viewport,
		deviceScaleFactor: opts.deviceScaleFactor,
		storageState: opts.storageState,
		colorScheme: opts.colorScheme,
		reducedMotion: opts.reducedMotion,
	});
	const page = await context.newPage();
	return { browser, context, page, close: () => browser.close() };
}
