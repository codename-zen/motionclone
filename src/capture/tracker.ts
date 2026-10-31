import type { Page } from "playwright";
import type { TrackedElement } from "./types.ts";

export const MAX_MATCHES_PER_SELECTOR = 200;

export interface TrackSample {
	scrollY: number;
	elements: Record<string, TrackedElement[]>;
	truncated: Record<string, number>;
}

export function sampleTrack(
	page: Page,
	selectors: string[],
): Promise<TrackSample> {
	return page.evaluate(
		({ selectors, max }) => {
			const elements: Record<string, TrackedElement[]> = {};
			const truncated: Record<string, number> = {};
			for (const sel of selectors) {
				const all = Array.from(document.querySelectorAll(sel));
				if (all.length > max) truncated[sel] = all.length;
				elements[sel] = all.slice(0, max).map((el, index) => {
					const r = el.getBoundingClientRect();
					const cs = getComputedStyle(el);
					return {
						index,
						x: r.x,
						y: r.y,
						w: r.width,
						h: r.height,
						opacity: Number.parseFloat(cs.opacity),
						transform: cs.transform,
						filter: cs.filter,
						clipPath: cs.clipPath,
						color: cs.color,
						backgroundColor: cs.backgroundColor,
						boxShadow: cs.boxShadow,
					};
				});
			}
			return { scrollY: window.scrollY, elements, truncated };
		},
		{ selectors, max: MAX_MATCHES_PER_SELECTOR },
	);
}
