import { easingLabel, unitCurve } from "../spec/easing.ts";
import { PROGRESS, type SpecRow } from "../spec/schema.ts";
import type { CloneMotion } from "./clone.ts";
import type { Metric } from "./schema.ts";

type Moving = Extract<CloneMotion, { status: "moving" }>;

const ms = (v: number | null) => Math.round(v ?? 0);
const num = (v: number) => Number(v.toFixed(Math.abs(v) >= 10 ? 1 : 3));

export const rowLabel = (row: SpecRow) =>
	`${row.selector}[${row.index}] ${row.property}`;

export function unitOf(property: string): string {
	if (
		property === "opacity" ||
		property === PROGRESS ||
		property.startsWith("scale")
	)
		return "";
	return property === "rotate" ? " deg" : " px";
}

const NEVER: Record<string, string> = {
	blur: "blurs",
	scale: "scales",
	scaleX: "scales horizontally",
	scaleY: "scales vertically",
	rotate: "rotates",
	[PROGRESS]: "changes its appearance there",
};

export function timingMessage(
	row: SpecRow,
	what: "start" | "end" | "duration",
	m: Metric,
): string {
	const d = ms(m.diff);
	if (what === "duration")
		return `${rowLabel(row)} runs ${Math.abs(d)} ms ${d > 0 ? "too long" : "too short"} (want ${ms(m.want)} ms, got ${ms(m.got)} ms)`;
	const verb = what === "start" ? "starts" : "ends";
	return `${rowLabel(row)} ${verb} ${Math.abs(d)} ms ${d > 0 ? "late" : "early"} (want ${ms(m.want)}, got ${ms(m.got)})`;
}

export const staggerMessage = (row: SpecRow, m: Metric) =>
	`${rowLabel(row)} starts ${ms(m.got)} ms after ${row.stagger?.after ?? "the previous item"} (want a ${ms(m.want)} ms stagger gap)`;

// Mean progress gap over the first half in normalised time; negative means the clone is slower early.
function earlyBias(want: (u: number) => number, got: (u: number) => number) {
	let sum = 0;
	for (let i = 1; i <= 10; i++) sum += got(i / 20) - want(i / 20);
	return sum / 10;
}

export function easingMessage(row: SpecRow, c: Moving, m: Metric): string {
	const got = c.easing;
	const bias = earlyBias(unitCurve(row.easing), unitCurve(got));
	const how =
		got.type === "linear"
			? "too linear"
			: bias < -0.02
				? "too slow at the start"
				: bias > 0.02
					? "too fast at the start"
					: "differs in shape";
	return `${rowLabel(row)} easing ${how}: max deviation ${num(m.diff ?? 0)} from ${easingLabel(row.easing)}; the clone fits ${easingLabel(got)}`;
}

export const overshootMessage = (row: SpecRow, m: Metric) =>
	`${rowLabel(row)} overshoots ${num(m.got ?? 0)} % past its end value (want ${num(m.want ?? 0)} %)`;

export function distanceMessage(row: SpecRow, c: Moving, m: Metric): string {
	const unit = unitOf(row.property);
	const want = Math.abs(row.to - row.from);
	const got = Math.abs(c.motion.window.change);
	const pct = Math.round(Math.abs(m.diff ?? 0) * 100);
	const relative =
		row.relativeDistance !== null ? ", relative to its size" : "";
	return `${rowLabel(row)} moves ${num(got)}${unit} (want ${num(want)}${unit}, ${pct} % ${(m.diff ?? 0) < 0 ? "short" : "too far"}${relative})`;
}

export const directionMessage = (row: SpecRow, c: Moving) =>
	`${rowLabel(row)} moves the wrong way (want ${num(row.from)} -> ${num(row.to)}, got ${num(c.motion.window.from)} -> ${num(c.motion.window.to)})`;

export function staticMessage(row: SpecRow, standIns: string[]): string {
	const unit = unitOf(row.property);
	const want = `want ${num(row.from)}${unit} -> ${num(row.to)}${unit} from ${ms(row.startMs)} ms over ${ms(row.durationMs)} ms`;
	const never = NEVER[row.property];
	const head = never
		? `${rowLabel(row)} missing: ${want}, the clone never ${never}`
		: `${rowLabel(row)} does not move in the clone (${want})`;
	return `${head}${standIns.length ? `; it moves its layout box (${standIns.join(", ")}) instead: animate ${row.property}` : ""}`;
}

export const missingMessage = (
	selector: string,
	index: number,
	matched: number,
) =>
	`${selector}[${index}] is missing in the clone: ${selector} matched ${matched} element${matched === 1 ? "" : "s"}, want at least ${index + 1}`;
