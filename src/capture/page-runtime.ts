import type { PageAnimationRecord } from "./types.ts";

export interface PageRuntime {
	step(tMs: number): void;
	tagCdp(animation: Animation, cdpId: string): void;
	matchTracked(selectors: string[]): void;
	trackedPaths(selectors: string[], max: number): Record<string, string[]>;
	records: PageAnimationRecord[];
	contexts: string[];
}

// Runs in the page before any page script; must stay self-contained because Playwright serializes it.
export function installPageRuntime(seed: number): void {
	let s = seed >>> 0;
	Math.random = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let r = s;
		r = Math.imul(r ^ (r >>> 15), r | 1);
		r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};

	interface Seen {
		id: number;
		lastPerf: number;
	}
	const seen = new WeakMap<Animation, Seen>();
	const cdpIds = new WeakMap<Animation, string>();
	const records: PageAnimationRecord[] = [];
	const contexts: string[] = [];
	// Records made before the first step are fixed up by it.
	let stepT: number | null = null;
	let stepPerf = 0;
	const early: { rec: PageAnimationRecord; info: Seen }[] = [];

	const describe = (el: Element | null, pseudo: string | null): string => {
		if (!el) return "(none)";
		let out = el.tagName.toLowerCase();
		if (el.id) out += `#${el.id}`;
		for (const c of Array.from(el.classList)) out += `.${c}`;
		return pseudo ? out + pseudo : out;
	};

	const targets: (Element | null)[] = [];
	const nodePath = (el: Element): string => {
		const parts: string[] = [];
		for (let e: Element | null = el; e; e = e.parentElement) {
			const parent = e.parentElement;
			const tag = e.tagName.toLowerCase();
			parts.unshift(
				parent
					? `${tag}:nth-child(${Array.from(parent.children).indexOf(e) + 1})`
					: tag,
			);
		}
		return parts.join(" > ");
	};

	const timelineKind = (a: Animation): string => {
		const tl = a.timeline;
		if (tl === document.timeline) return "document";
		if (!tl) return "none";
		const name = tl.constructor.name;
		if (name === "ViewTimeline") return "view";
		if (name === "ScrollTimeline") return "scroll";
		return "other";
	};

	const register = (a: Animation, bornPerf: number): Seen => {
		const effect = a.effect as KeyframeEffect | null;
		const timing = effect?.getTiming() ?? {};
		const kind = a.constructor.name;
		const css = a as Animation & {
			animationName?: string;
			transitionProperty?: string;
		};
		const name = css.animationName ?? css.transitionProperty ?? a.id ?? "";
		const iterations = timing.iterations ?? 1;
		const info: Seen = { id: records.length + 1, lastPerf: bornPerf };
		const target = effect?.target ?? null;
		targets.push(target);
		const rec: PageAnimationRecord = {
			id: info.id,
			type:
				kind === "CSSAnimation" || kind === "CSSTransition"
					? kind
					: "WebAnimation",
			name,
			target: describe(effect?.target ?? null, effect?.pseudoElement ?? null),
			properties: [
				...new Set(
					(effect?.getKeyframes() ?? []).flatMap((k) =>
						Object.keys(k)
							.filter(
								(p) =>
									!["offset", "easing", "composite", "computedOffset"].includes(
										p,
									),
							)
							.map((p) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)),
					),
				),
			].sort(),
			startMs: stepT === null ? 0 : stepT + (bornPerf - stepPerf),
			duration: (timing.duration as number | string | undefined) ?? 0,
			delay: timing.delay ?? 0,
			endDelay: timing.endDelay ?? 0,
			iterations: Number.isFinite(iterations) ? iterations : "infinite",
			iterationStart: timing.iterationStart ?? 0,
			direction: timing.direction ?? "normal",
			fill: timing.fill ?? "auto",
			easing: timing.easing ?? "linear",
			keyframes: (effect?.getKeyframes() ?? []).map((k) => ({
				offset: (k.computedOffset as number) ?? 0,
				easing: (k.easing as string) ?? "linear",
			})),
			timeline: timelineKind(a),
			playbackRate: a.playbackRate,
			cdpId: cdpIds.get(a) ?? null,
			nodePath: target ? nodePath(target) : null,
			tracked: [],
		};
		records.push(rec);
		if (stepT === null) early.push({ rec, info });
		seen.set(a, info);
		return info;
	};

	// The document timeline is frozen over CDP, so animations only move when step() sets currentTime.
	const advance = (now: number): void => {
		for (const a of document.getAnimations()) {
			const info = seen.get(a) ?? register(a, now);
			if (a.timeline === document.timeline && a.playState === "running") {
				const base = (a.currentTime as number | null) ?? 0;
				a.currentTime = base + (now - info.lastPerf) * a.playbackRate;
			}
			info.lastPerf = now;
		}
	};

	// Same order as a rendering update: animations, then rAF callbacks, then a pass that picks up
	// animations those callbacks created.
	const step = (tMs: number): void => {
		const now = performance.now();
		if (stepT === null)
			// Animations created during load stay pending until the first frame, as in a real browser.
			for (const e of early) {
				e.rec.startMs = tMs;
				e.info.lastPerf = now;
			}
		stepT = tMs;
		stepPerf = now;
		advance(now);
		(
			window as unknown as { __motioncloneFlushRaf(now: number): void }
		).__motioncloneFlushRaf(now);
		advance(now);
	};

	const originalAnimate = Element.prototype.animate;
	Element.prototype.animate = function (
		this: Element,
		...args: Parameters<Element["animate"]>
	) {
		const a = originalAnimate.apply(this, args);
		if (!seen.has(a)) register(a, performance.now());
		return a;
	};

	// A virtual-time write (page-timeline.ts) moves the animation's reference point for advance().
	Object.defineProperty(window, "__motioncloneTouch", {
		value: (a: Animation): void => {
			const info = seen.get(a);
			if (info) info.lastPerf = performance.now();
		},
		enumerable: false,
	});

	const onCssEvent = (e: Event): void => {
		const el = e.target as Element;
		const ae = e as AnimationEvent & TransitionEvent;
		const name =
			e.type === "animationstart" ? ae.animationName : ae.propertyName;
		const match = (el.getAnimations?.() ?? []).find((a) => {
			const css = a as Animation & {
				animationName?: string;
				transitionProperty?: string;
			};
			return (css.animationName ?? css.transitionProperty) === name;
		});
		if (match && !seen.has(match)) register(match, performance.now());
	};
	document.addEventListener("animationstart", onCssEvent, true);
	document.addEventListener("transitionrun", onCssEvent, true);

	const originalGetContext = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (
		this: HTMLCanvasElement,
		type: string,
		...rest: unknown[]
	) {
		if (!contexts.includes(type)) contexts.push(type);
		return (originalGetContext as (...a: unknown[]) => unknown).call(
			this,
			type,
			...rest,
		);
	} as typeof HTMLCanvasElement.prototype.getContext;

	const runtime: PageRuntime = {
		step,
		tagCdp: (a, cdpId) => {
			cdpIds.set(a, cdpId);
			const info = seen.get(a);
			const rec = info && records[info.id - 1];
			if (rec) rec.cdpId = cdpId;
		},
		// Indexes match track.json's querySelectorAll order at the end of the capture.
		matchTracked: (selectors) => {
			for (const rec of records) {
				const el = targets[rec.id - 1];
				if (!el?.isConnected) continue;
				rec.nodePath = nodePath(el);
				rec.tracked = selectors.flatMap((selector) => {
					const index = Array.from(document.querySelectorAll(selector)).indexOf(
						el,
					);
					return index < 0 ? [] : [{ selector, index }];
				});
			}
		},
		trackedPaths: (selectors, max) =>
			Object.fromEntries(
				selectors.map((selector) => [
					selector,
					Array.from(document.querySelectorAll(selector))
						.slice(0, max)
						.map(nodePath),
				]),
			),
		records,
		contexts,
	};
	Object.defineProperty(window, "__motionclone", {
		value: runtime,
		enumerable: false,
	});
}
