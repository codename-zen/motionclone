/** 2D affine matrix [a, b, c, d, e, f] as in CSS matrix(). */
export type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const multiply = (m: Matrix, n: Matrix): Matrix => [
	m[0] * n[0] + m[2] * n[1],
	m[1] * n[0] + m[3] * n[1],
	m[0] * n[2] + m[2] * n[3],
	m[1] * n[2] + m[3] * n[3],
	m[0] * n[4] + m[2] * n[5] + m[4],
	m[1] * n[4] + m[3] * n[5] + m[5],
];

/** The 2D part of a computed transform (matrix or matrix3d); null for none or anything else. */
export function parseMatrix(transform: string): Matrix | null {
	const m = /^(matrix3d|matrix)\(([^)]*)\)$/.exec(transform.trim());
	if (!m) return null;
	const v = (m[2] ?? "").split(",").map(Number);
	const is3d = m[1] === "matrix3d";
	if (v.length !== (is3d ? 16 : 6) || v.some((n) => !Number.isFinite(n)))
		return null;
	const pick = is3d ? [0, 1, 4, 5, 12, 13] : [0, 1, 2, 3, 4, 5];
	return pick.map((i) => v[i] as number) as Matrix;
}

const isNone = (s: string | undefined) =>
	s === undefined || s.trim() === "" || s.trim() === "none";

// Percentages in `translate` resolve against the element's own size.
function length(text: string, size: number): number {
	const t = text.trim();
	if (t.endsWith("%")) return (Number.parseFloat(t) / 100) * size;
	const n = Number.parseFloat(t);
	return Number.isFinite(n) ? n : 0;
}

function angleDeg(text: string): number {
	const m = /^(-?[\d.e+-]+)(deg|rad|turn|grad)?$/.exec(text.trim());
	if (!m) return 0;
	const v = Number(m[1]);
	switch (m[2]) {
		case "rad":
			return (v * 180) / Math.PI;
		case "turn":
			return v * 360;
		case "grad":
			return v * 0.9;
		default:
			return v;
	}
}

export interface IndividualTransforms {
	translate?: string;
	rotate?: string;
	scale?: string;
}

/** The individual `translate`, `rotate` and `scale` properties as one matrix; null when all are none. */
export function individualMatrix(
	p: IndividualTransforms,
	size: { w: number; h: number },
): Matrix | null {
	if (isNone(p.translate) && isNone(p.rotate) && isNone(p.scale)) return null;
	let m = IDENTITY;
	if (!isNone(p.translate)) {
		const [x = "0", y = "0"] = (p.translate as string).trim().split(/\s+/);
		m = multiply(m, [1, 0, 0, 1, length(x, size.w), length(y, size.h)]);
	}
	if (!isNone(p.rotate)) {
		// Only rotation about the z axis is 2D: "45deg", "z 45deg" or "0 0 1 45deg".
		const parts = (p.rotate as string).trim().split(/\s+/);
		const axis = parts.slice(0, -1).join(" ");
		if (axis === "" || axis === "z" || axis === "0 0 1") {
			const a = (angleDeg(parts.at(-1) ?? "0") * Math.PI) / 180;
			m = multiply(m, [
				Math.cos(a),
				Math.sin(a),
				-Math.sin(a),
				Math.cos(a),
				0,
				0,
			]);
		}
	}
	if (!isNone(p.scale)) {
		const [sx = "1", sy = sx] = (p.scale as string).trim().split(/\s+/);
		const num = (s: string) =>
			s.endsWith("%") ? Number.parseFloat(s) / 100 : Number.parseFloat(s);
		m = multiply(m, [num(sx), 0, 0, num(sy), 0, 0]);
	}
	return m;
}

/** CSS applies translate, rotate and scale before transform: the combined 2D matrix, or null for identity input. */
export function effectiveMatrix(
	transform: string,
	p: IndividualTransforms,
	size: { w: number; h: number },
): Matrix | null {
	const t = parseMatrix(transform);
	const i = individualMatrix(p, size);
	if (!i) return t;
	return t ? multiply(i, t) : i;
}

/** Blur radius in px from a computed filter; several blurs combine like Gaussians. */
export function blurPx(filter: string): number {
	let sq = 0;
	for (const m of filter.matchAll(/blur\(\s*([\d.e+-]+)px\s*\)/g)) {
		const r = Number(m[1]);
		if (Number.isFinite(r)) sq += r * r;
	}
	return Math.sqrt(sq);
}
