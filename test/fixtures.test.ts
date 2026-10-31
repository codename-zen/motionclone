import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Answer, AnswerRow } from "../fixtures/answer-schema.ts";
import { listFixtures } from "../fixtures/index.ts";
import { type StaticServer, serveRepo } from "./serve.ts";

interface Seen {
	delay: number;
	duration: number | string;
	iterations: number;
	easing: string;
	timeline: string;
}

let server: StaticServer;
let browser: Browser;
const fixtures = listFixtures();

beforeAll(async () => {
	server = await serveRepo();
	browser = await chromium.launch();
});

afterAll(async () => {
	await browser?.close();
	await server?.close();
});

// Records every animation the page creates, since transitions finish quickly.
const RECORDER = `
window.__seen = [];
const known = new Set();
const tick = () => {
	for (const a of document.getAnimations()) {
		if (known.has(a)) continue;
		known.add(a);
		const t = a.effect.getTiming();
		const kf = a.effect.getKeyframes()[0];
		window.__seen.push({
			el: a.effect.target,
			delay: t.delay,
			duration: t.duration,
			iterations: t.iterations,
			easing: a instanceof CSSAnimation && kf ? kf.easing : t.easing,
			timeline: a.timeline.constructor.name,
		});
	}
	requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
`;

function canon(e: string): string {
	const named: Record<string, string> = {
		ease: "cubic-bezier(0.25, 0.1, 0.25, 1)",
		"ease-in": "cubic-bezier(0.42, 0, 1, 1)",
		"ease-out": "cubic-bezier(0, 0, 0.58, 1)",
		"ease-in-out": "cubic-bezier(0.42, 0, 0.58, 1)",
		"step-end": "steps(1)",
		"step-start": "steps(1, start)",
	};
	return (named[e] ?? e).replace(/,\s*end\)/, ")").replace(/\s+/g, "");
}

function expected(row: AnswerRow): string {
	const e = row.easing;
	if (e.type === "linear") return "linear";
	if (e.type === "cubic-bezier") return canon(`cubic-bezier(${e.p.join(",")})`);
	if (e.type === "steps") return canon(`steps(${e.count},${e.position})`);
	return "";
}

function rowSeen(page: Page, row: AnswerRow): Promise<Seen[]> {
	return page.evaluate(
		({ selector, index }) => {
			const el = document.querySelectorAll(selector)[index];
			// biome-ignore lint/suspicious/noExplicitAny: recorder is injected
			return (window as any).__seen
				.filter((s: { el: Element }) => s.el === el)
				.map(({ el: _el, ...rest }: { el: Element }) => rest);
		},
		{ selector: row.selector, index: row.index },
	);
}

async function open(
	name: string,
	answer: Answer,
	errors: string[],
	reducedMotion?: "reduce",
) {
	const ctx = await browser.newContext({
		viewport: answer.viewport,
		reducedMotion,
	});
	await ctx.addInitScript(RECORDER);
	const page = await ctx.newPage();
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(`${server.url}/fixtures/${name}/index.html`);
	return { page, close: () => ctx.close() };
}

async function fire(page: Page, answer: Answer) {
	const t = answer.trigger;
	if (t.type === "hover") await page.hover(t.target);
	if (t.type === "click") await page.click(t.target);
	if (t.type === "scroll")
		await page.evaluate((y) => window.scrollTo(0, y), t.toPx);
}

describe("answer keys", () => {
	it("lists ten fixtures that validate", () => {
		expect(fixtures.map((f) => f.dir).sort()).toEqual(
			expect.arrayContaining([
				"css-fade-up-stagger",
				"css-hover-lift",
				"css-transition-click",
				"waapi-sequence",
				"css-steps-loader",
				"css-marquee",
				"gsap-timeline",
				"motion-spring",
				"scroll-linked",
				"reduced-motion",
			]),
		);
	});
});

describe.each(
	fixtures.filter((f) =>
		f.answer.rows.every(
			(r) => r.source.startsWith("css") || r.source === "waapi",
		),
	),
)("$dir", ({ dir, answer }) => {
	it("declared timings match the browser", async () => {
		const errors: string[] = [];
		const { page, close } = await open(dir, answer, errors);
		await fire(page, answer);
		await page.waitForTimeout(150);
		for (const row of answer.rows) {
			const seen = await rowSeen(page, row);
			const scroll = row.scrollLinked !== undefined;
			const hit = seen.find(
				(s) =>
					canon(s.easing) === expected(row) &&
					(scroll
						? s.timeline === "ScrollTimeline"
						: s.duration === row.durationMs &&
							Math.abs(s.delay - row.startMs) < 0.01 &&
							(s.iterations === Number.POSITIVE_INFINITY
								? "infinite"
								: s.iterations) === row.iterations),
			);
			expect(
				hit,
				`${row.selector}[${row.index}] ${row.property}: ${JSON.stringify(seen)}`,
			).toBeDefined();
		}
		expect(errors).toEqual([]);
		await close();
	});
});

describe("reduced-motion", () => {
	it("has no animations when the user prefers reduced motion", async () => {
		const answer = fixtures.find((f) => f.dir === "reduced-motion")
			?.answer as Answer;
		const errors: string[] = [];
		const { page, close } = await open(
			"reduced-motion",
			answer,
			errors,
			"reduce",
		);
		await page.waitForTimeout(150);
		expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
		expect(errors).toEqual([]);
		await close();
	});
});

describe("scroll-linked", () => {
	it("progress bar follows the scroll position", async () => {
		const answer = fixtures.find((f) => f.dir === "scroll-linked")
			?.answer as Answer;
		const { page, close } = await open("scroll-linked", answer, []);
		await page.evaluate(() => window.scrollTo(0, 600));
		await page.waitForTimeout(150);
		const half = await page.evaluate(
			() =>
				new DOMMatrix(
					getComputedStyle(document.querySelector(".progress") as Element)
						.transform,
				).a,
		);
		expect(half).toBeCloseTo(0.5, 1);
		await close();
	});
});

describe("gsap-timeline", () => {
	it("registers the declared tweens on the global timeline", async () => {
		const answer = fixtures.find((f) => f.dir === "gsap-timeline")
			?.answer as Answer;
		const errors: string[] = [];
		const { page, close } = await open("gsap-timeline", answer, errors);
		const info = await page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: gsap is a page global
			const g = (window as any).gsap;
			const tweens = g.globalTimeline.getChildren(true, true, true);
			return {
				top: g.globalTimeline.getChildren().length,
				vars: tweens.map((t: { vars: object }) => t.vars),
			};
		});
		expect(info.top).toBeGreaterThan(0);
		expect(info.vars).toContainEqual(
			expect.objectContaining({
				y: 40,
				opacity: 0,
				duration: 0.8,
				ease: "power3.out",
				stagger: 0.12,
			}),
		);
		expect(errors).toEqual([]);
		await close();
	});
});

describe("motion-spring", () => {
	it("moves the box after click", async () => {
		const answer = fixtures.find((f) => f.dir === "motion-spring")
			?.answer as Answer;
		const errors: string[] = [];
		const { page, close } = await open("motion-spring", answer, errors);
		const left = () =>
			page.evaluate(
				() =>
					(document.querySelector(".box") as Element).getBoundingClientRect()
						.left,
			);
		const before = await left();
		await page.click(".go");
		await page.waitForTimeout(1000);
		expect(Math.round((await left()) - before)).toBe(200);
		expect(errors).toEqual([]);
		await close();
	});
});
