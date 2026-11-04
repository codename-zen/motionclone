import type { AnimationRecord } from "../capture/types.ts";
import { type MovingProperty, readTrack } from "../measure/elements.ts";
import {
	readAnimations,
	readCaptureFile,
	readTrackedPaths,
} from "../spec/capture-file.ts";
import { candidateEasing, unitCurve } from "../spec/easing.ts";
import { elementKey, fitMotion, motionProperties } from "../spec/motion.ts";
import { checkReducedMotion } from "./reduced-motion.ts";
import type { Guardrail } from "./schema.ts";

const LAYOUT =
	/^(width|height|top|left|right|bottom|inset|margin|padding)(-|$)/;
const BOX_PROPS = new Set(["x", "y", "width", "height"]);
const TRANSFORM_FOR: Record<string, string> = {
	x: "translateX",
	y: "translateY",
	width: "scaleX",
	height: "scaleY",
};

const TRANSFORM_PROPS = /^(transform|translate|scale|rotate)$/;

const animatesTransform = (a: AnimationRecord): boolean =>
	(a.properties ?? []).some((p) => TRANSFORM_PROPS.test(p)) ||
	(a.type === "CSSTransition" && TRANSFORM_PROPS.test(a.name));

/** True when a transform animation on an ancestor of the tracked element moves its box. */
function movedByAncestor(
	animations: AnimationRecord[],
	paths: Record<string, string[]>,
	m: MovingProperty,
): boolean {
	const own = paths[m.selector]?.[m.index];
	if (!own) return false;
	return animations.some(
		(a) =>
			a.nodePath !== null &&
			own.startsWith(`${a.nodePath} > `) &&
			animatesTransform(a),
	);
}

// Ends at the element's resting state: opacity rising to visible, or a transform settling at identity.
function isEntrance(m: MovingProperty): boolean {
	const { from, to } = m.window;
	if (m.property === "opacity") return from <= 0.05 && to >= 0.95;
	if (m.property.startsWith("translate") || m.property === "rotate")
		return Math.abs(to) < 0.5 && Math.abs(from) >= 0.5;
	if (m.property.startsWith("scale"))
		return Math.abs(to - 1) < 0.005 && Math.abs(from - 1) >= 0.005;
	return false;
}

function layoutWarnings(
	animations: AnimationRecord[],
	paths: Record<string, string[]>,
	motions: MovingProperty[],
	scrolls: boolean,
): Guardrail[] {
	const out: Guardrail[] = [];
	for (const a of animations)
		if (a.type === "CSSTransition" && LAYOUT.test(a.name))
			out.push({
				rule: "layout-property",
				target: a.target,
				message: `${a.target} transitions ${a.name}, which re-runs layout every frame; animate transform (translate or scale) instead`,
			});
	// Scrolling moves every box, so box motion says nothing about layout animation then.
	if (scrolls) return out;
	for (const m of motions)
		if (BOX_PROPS.has(m.property) && !movedByAncestor(animations, paths, m))
			out.push({
				rule: "layout-property",
				target: elementKey(m.selector, m.index),
				message: `${elementKey(m.selector, m.index)} changes its layout box (${m.property}) without a transform; animate ${TRANSFORM_FOR[m.property]} instead of ${m.property === "x" || m.property === "y" ? "top/left/margin" : m.property}`,
			});
	return out;
}

function easeInWarnings(motions: MovingProperty[]): Guardrail[] {
	const byElement = new Map<string, string[]>();
	for (const m of motions) {
		if (!isEntrance(m)) continue;
		const curve = unitCurve(candidateEasing(fitMotion(m).best));
		if (curve(0.5) >= 0.4) continue;
		const key = elementKey(m.selector, m.index);
		byElement.set(key, [...(byElement.get(key) ?? []), m.property]);
	}
	return [...byElement].map(([target, props]) => ({
		rule: "ease-in-entrance" as const,
		target,
		message: `${target} enters with an ease-in curve (${props.join(", ")}), which feels sluggish; use an ease-out curve for entrances`,
	}));
}

async function reducedMotionWarnings(
	cloneDir: string,
	reducedDir: string,
): Promise<Guardrail[]> {
	const check = await checkReducedMotion(cloneDir, reducedDir);
	if (check.pass !== false) return [];
	return [
		{
			rule: "reduced-motion",
			target: check.unchanged.join(", "),
			message: check.message,
		},
	];
}

/** Common rebuild mistakes in a clone capture; warnings only, never failures. */
export async function guardrails(
	cloneDir: string,
	{ reducedClone }: { reducedClone?: string } = {},
): Promise<Guardrail[]> {
	const [cap, track, animations, paths] = await Promise.all([
		readCaptureFile(cloneDir),
		readTrack(cloneDir),
		readAnimations(cloneDir),
		readTrackedPaths(cloneDir),
	]);
	const motions = motionProperties(track);
	return [
		...layoutWarnings(
			animations,
			paths,
			motions,
			cap.options.trigger.type === "scroll",
		),
		...easeInWarnings(motions),
		...(reducedClone
			? await reducedMotionWarnings(cloneDir, reducedClone)
			: []),
	];
}
