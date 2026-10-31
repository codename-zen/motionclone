export type BezierParams = readonly [number, number, number, number];

export interface Preset {
	name: string;
	p: BezierParams;
	aliases?: string[];
}

const power = (
	n: number,
	name: string,
	p: [BezierParams, BezierParams, BezierParams],
) =>
	(["in", "out", "inOut"] as const).map(
		(dir, i): Preset => ({
			name: `ease${dir[0]?.toUpperCase()}${dir.slice(1)}${name}`,
			p: p[i] as BezierParams,
			aliases: n ? [`power${n}.${dir}`] : [],
		}),
	);

// CSS keywords, Material, easings.net curves and their GSAP power equivalents.
export const PRESETS: readonly Preset[] = [
	{ name: "linear", p: [0, 0, 1, 1] },
	{ name: "ease", p: [0.25, 0.1, 0.25, 1] },
	{ name: "ease-in", p: [0.42, 0, 1, 1] },
	{ name: "ease-out", p: [0, 0, 0.58, 1] },
	{ name: "ease-in-out", p: [0.42, 0, 0.58, 1] },
	{ name: "material-standard", p: [0.4, 0, 0.2, 1] },
	{ name: "material-decelerate", p: [0, 0, 0.2, 1] },
	{ name: "material-accelerate", p: [0.4, 0, 1, 1] },
	{ name: "material-emphasized", p: [0.2, 0, 0, 1] },
	{ name: "material-emphasized-decelerate", p: [0.05, 0.7, 0.1, 1] },
	{ name: "material-emphasized-accelerate", p: [0.3, 0, 0.8, 0.15] },
	...power(0, "Sine", [
		[0.12, 0, 0.39, 0],
		[0.61, 1, 0.88, 1],
		[0.37, 0, 0.63, 1],
	]),
	...power(1, "Quad", [
		[0.11, 0, 0.5, 0],
		[0.5, 1, 0.89, 1],
		[0.45, 0, 0.55, 1],
	]),
	...power(2, "Cubic", [
		[0.32, 0, 0.67, 0],
		[0.33, 1, 0.68, 1],
		[0.65, 0, 0.35, 1],
	]),
	...power(3, "Quart", [
		[0.5, 0, 0.75, 0],
		[0.25, 1, 0.5, 1],
		[0.76, 0, 0.24, 1],
	]),
	...power(4, "Quint", [
		[0.64, 0, 0.78, 0],
		[0.22, 1, 0.36, 1],
		[0.83, 0, 0.17, 1],
	]),
	...power(0, "Expo", [
		[0.7, 0, 0.84, 0],
		[0.16, 1, 0.3, 1],
		[0.87, 0, 0.13, 1],
	]),
	...power(0, "Circ", [
		[0.55, 0, 1, 0.45],
		[0, 0.55, 0.45, 1],
		[0.85, 0, 0.15, 1],
	]),
	...power(0, "Back", [
		[0.36, 0, 0.66, -0.56],
		[0.34, 1.56, 0.64, 1],
		[0.68, -0.6, 0.32, 1.6],
	]),
	// Penner's cubic curves, the values GSAP-era CSS ports use.
	{ name: "penner-in-cubic", p: [0.55, 0.055, 0.675, 0.19] },
	{ name: "penner-out-cubic", p: [0.215, 0.61, 0.355, 1] },
	{ name: "penner-in-out-cubic", p: [0.645, 0.045, 0.355, 1] },
];

export const cssBezier = (p: BezierParams): string =>
	`cubic-bezier(${p.join(", ")})`;
