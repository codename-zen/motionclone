import { type MovingProperty, readTrack } from "../measure/elements.ts";
import { readAnimations, readCaptureFile } from "../spec/capture-file.ts";
import { candidateEasing, unitCurve } from "../spec/easing.ts";
import { elementKey, fitMotion, motionProperties } from "../spec/motion.ts";
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
	animations: Awaited<ReturnType<typeof readAnimations>>,
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
		if (BOX_PROPS.has(m.property))
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
	motions: MovingProperty[],
	reducedDir: string,
): Promise<Guardrail[]> {
	const reduced = new Map(
		motionProperties(await readTrack(reducedDir)).map((m) => [
			`${elementKey(m.selector, m.index)}.${m.property}`,
			m,
		]),
	);
	const unchanged = motions.filter((m) => {
		if (m.property === "opacity") return false;
		const r = reduced.get(`${elementKey(m.selector, m.index)}.${m.property}`);
		const size = (w: MovingProperty["window"]) =>
			Math.abs(w.thereAndBack ? w.peak - w.from : w.change);
		return r !== undefined && size(r.window) >= 0.5 * size(m.window);
	});
	if (unchanged.length === 0) return [];
	return [
		{
			rule: "reduced-motion",
			target: unchanged
				.map((m) => `${elementKey(m.selector, m.index)}.${m.property}`)
				.join(", "),
			message: `motion is unchanged with prefers-reduced-motion: reduce (${unchanged.length} moving properties, e.g. ${elementKey(unchanged[0]?.selector ?? "", unchanged[0]?.index ?? 0)} ${unchanged[0]?.property}); add a @media (prefers-reduced-motion: reduce) rule that removes or shortens the movement`,
		},
	];
}

/** Common rebuild mistakes in a clone capture; warnings only, never failures. */
export async function guardrails(
	cloneDir: string,
	{ reducedClone }: { reducedClone?: string } = {},
): Promise<Guardrail[]> {
	const [cap, track, animations] = await Promise.all([
		readCaptureFile(cloneDir),
		readTrack(cloneDir),
		readAnimations(cloneDir),
	]);
	const motions = motionProperties(track);
	return [
		...layoutWarnings(
			animations,
			motions,
			cap.options.trigger.type === "scroll",
		),
		...easeInWarnings(motions),
		...(reducedClone ? await reducedMotionWarnings(motions, reducedClone) : []),
	];
}
