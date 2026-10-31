import type { AnimationRecord } from "../capture/types.ts";
import { bezierY } from "../fit/bezier.ts";
import type { Candidate } from "../fit/classify.ts";
import { type BezierParams, cssBezier, PRESETS } from "../fit/presets.ts";
import {
	dampingRatio,
	type Spring,
	settleMs,
	springResponse,
	toCssLinear,
} from "../fit/spring.ts";
import { stepsY } from "../fit/steps.ts";
import type { Easing } from "./schema.ts";

const round = (v: number, digits = 4) => Number(v.toFixed(digits));

export function bezierEasing(p: BezierParams): Easing {
	const rounded = p.map((v) => round(v)) as [number, number, number, number];
	const preset = PRESETS.find((pr) =>
		pr.p.every((v, i) => Math.abs(v - (rounded[i] as number)) < 1e-3),
	);
	if (preset?.name === "linear") return { type: "linear" };
	return {
		type: "cubic-bezier",
		p: rounded,
		name: preset?.name ?? null,
		aliases: preset?.aliases ?? [],
	};
}

export function springEasing(s: Spring): Easing {
	const css = toCssLinear(s);
	return {
		type: "spring",
		stiffness: round(s.stiffness, 2),
		damping: round(s.damping, 2),
		mass: round(s.mass, 3),
		zeta: round(dampingRatio(s)),
		settleMs: settleMs(s),
		cssLinear: { css: css.css, durationMs: css.durationMs },
	};
}

const KEYWORDS: Record<string, string> = {
	ease: "ease",
	"ease-in": "ease-in",
	"ease-out": "ease-out",
	"ease-in-out": "ease-in-out",
};

/** A CSS <easing-function> string as a spec easing; null for linear() point lists and anything unknown. */
export function parseCssEasing(text: string): Easing | null {
	const s = text.trim();
	if (s === "linear") return { type: "linear" };
	const keyword = KEYWORDS[s];
	if (keyword) {
		const preset = PRESETS.find((p) => p.name === keyword);
		return preset ? bezierEasing(preset.p) : null;
	}
	if (s === "step-start") return { type: "steps", count: 1, position: "start" };
	if (s === "step-end") return { type: "steps", count: 1, position: "end" };
	const bez = /^cubic-bezier\(([^)]*)\)$/.exec(s);
	if (bez) {
		const v = (bez[1] ?? "").split(",").map(Number);
		if (v.length !== 4 || v.some((n) => !Number.isFinite(n))) return null;
		return bezierEasing(v as unknown as BezierParams);
	}
	const steps = /^steps\(\s*(\d+)\s*(?:,\s*([a-z-]+)\s*)?\)$/.exec(s);
	if (steps) {
		const pos = steps[2] ?? "end";
		const position =
			pos === "start" || pos === "jump-start"
				? "start"
				: pos === "end" || pos === "jump-end"
					? "end"
					: null;
		if (!position) return null;
		return { type: "steps", count: Number(steps[1]), position };
	}
	return null;
}

/** The easing that shapes the whole animation: effect easing, or the single keyframe easing CSS animations carry. */
export function declaredEasing(a: AnimationRecord): Easing | null {
	const kf = a.keyframes
		.filter((k) => k.offset < 1)
		.map((k) => k.easing.trim());
	const shaped = kf.filter((e) => e !== "linear");
	const effect = a.easing.trim();
	if (effect !== "linear" && shaped.length === 0) return parseCssEasing(effect);
	if (effect === "linear" && kf.length <= 1)
		return parseCssEasing(kf[0] ?? "linear");
	// Several keyframe segments with their own easings are multi-segment motion, not one curve.
	return null;
}

export function candidateEasing(c: Candidate): Easing {
	switch (c.kind) {
		case "linear":
			return { type: "linear" };
		case "preset":
		case "bezier":
			return bezierEasing(c.p);
		case "spring":
			return springEasing(c.spring);
		case "steps":
			return { type: "steps", count: c.count, position: c.position };
	}
}

/** Progress 0..1 over normalised time u in 0..1; springs span their 0.5 % settle time. */
export function unitCurve(e: Easing): (u: number) => number {
	switch (e.type) {
		case "linear":
			return (u) => Math.min(1, Math.max(0, u));
		case "cubic-bezier":
			return (u) => bezierY(e.p, u);
		case "steps":
			return (u) => stepsY(e.count, e.position, u);
		case "spring": {
			const span = e.cssLinear.durationMs;
			return (u) => (u >= 1 ? 1 : springResponse(e, (u * span) / 1000));
		}
	}
}

/** How long the unit curve of an easing runs for a row duration; spring rows store the 2 % settle time. */
export function curveSpanMs(e: Easing, durationMs: number): number {
	return e.type === "spring" ? e.cssLinear.durationMs : durationMs;
}

export function easingLabel(e: Easing): string {
	switch (e.type) {
		case "linear":
			return "linear";
		case "cubic-bezier":
			return `${cssBezier(e.p)}${e.name ? ` (${e.name})` : ""}`;
		case "steps":
			return `steps(${e.count}, ${e.position})`;
		case "spring":
			return `spring(stiffness ${e.stiffness}, damping ${e.damping}, mass ${e.mass}, zeta ${e.zeta})`;
	}
}
