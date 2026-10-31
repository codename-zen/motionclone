import type { Page } from "playwright";
import type { AnimationRecord, StackKind } from "./types.ts";

export async function detectStack(
	page: Page,
	animations: AnimationRecord[],
): Promise<StackKind[]> {
	const found = new Set<StackKind>();
	for (const a of animations) {
		if (a.timeline !== "document") found.add("scroll-driven");
		if (a.type === "CSSAnimation") found.add("css-animation");
		else if (a.type === "CSSTransition") found.add("css-transition");
		else found.add("waapi");
	}
	const page_ = await page.evaluate(() => {
		const w = window as unknown as Record<string, unknown> & {
			__motionclone?: { contexts: string[] };
		};
		return {
			gsap: Boolean(w.gsap),
			motion: Boolean(
				w.Motion ||
					w.MotionGlobalConfig ||
					document.querySelector(
						"[data-projection-id],[data-framer-appear-id],[data-motion-id]",
					),
			),
			canvas: document.querySelector("canvas") !== null,
			contexts: w.__motionclone?.contexts ?? [],
		};
	});
	if (page_.gsap) found.add("gsap");
	if (page_.motion) found.add("motion");
	if (page_.canvas || page_.contexts.includes("2d")) found.add("canvas");
	if (
		page_.contexts.some(
			(c) => c.startsWith("webgl") || c === "experimental-webgl",
		)
	)
		found.add("webgl");
	if (page_.contexts.includes("webgpu")) found.add("webgpu");
	const order: StackKind[] = [
		"css-animation",
		"css-transition",
		"waapi",
		"gsap",
		"motion",
		"canvas",
		"webgl",
		"webgpu",
		"scroll-driven",
	];
	return order.filter((k) => found.has(k));
}
