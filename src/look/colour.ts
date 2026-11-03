/** CIE Lab, D65 white. */
export interface Lab {
	l: number;
	a: number;
	b: number;
}

export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

const hex2 = (v: number) =>
	Math.max(0, Math.min(255, Math.round(v)))
		.toString(16)
		.padStart(2, "0");

/** "#rrggbb", or "#rrggbbaa" when not opaque. */
export function toHex(c: { r: number; g: number; b: number; a?: number }) {
	const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
	return c.a === undefined || c.a >= 1 ? base : `${base}${hex2(c.a * 255)}`;
}

export function parseHex(hex: string): Rgba {
	const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
	if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
	const v = Number.parseInt(m[1] as string, 16);
	return {
		r: (v >> 16) & 255,
		g: (v >> 8) & 255,
		b: v & 255,
		a: m[2] === undefined ? 1 : Number.parseInt(m[2], 16) / 255,
	};
}

/** True when the colour hides what lies under it. */
export const isOpaque = (hex: string) => parseHex(hex).a >= 0.99;
export const isVisible = (hex: string) => parseHex(hex).a > 0.01;

/** `top` painted over an opaque `under`. */
export function over(top: string, under: string): string {
	const t = parseHex(top);
	const u = parseHex(under);
	const mix = (x: number, y: number) => x * t.a + y * (1 - t.a);
	return toHex({ r: mix(t.r, u.r), g: mix(t.g, u.g), b: mix(t.b, u.b) });
}

const linear = (v: number) => {
	const c = v / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const LIN = Float64Array.from({ length: 256 }, (_, i) => linear(i));
const f = (t: number) =>
	t > 216 / 24389 ? Math.cbrt(t) : (t * 24389) / 27 / 116 + 16 / 116;

export function rgbToLab(r: number, g: number, b: number): Lab {
	const R = LIN[Math.round(r)] as number;
	const G = LIN[Math.round(g)] as number;
	const B = LIN[Math.round(b)] as number;
	const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
	const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
	const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
	const fy = f(y);
	return { l: 116 * fy - 16, a: 500 * (f(x) - fy), b: 200 * (fy - f(z)) };
}

const finv = (t: number) =>
	t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27);
const gamma = (c: number) =>
	255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function labToHex(lab: Lab): string {
	const fy = (lab.l + 16) / 116;
	const x = 0.95047 * finv(fy + lab.a / 500);
	const y = finv(fy);
	const z = 1.08883 * finv(fy - lab.b / 200);
	return toHex({
		r: gamma(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
		g: gamma(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
		b: gamma(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
	});
}

export const hexToLab = (hex: string): Lab => {
	const c = parseHex(hex);
	return rgbToLab(c.r, c.g, c.b);
};

/** Squared Lab distance (CIE76), for clustering. */
export const dist2 = (p: Lab, q: Lab) =>
	(p.l - q.l) ** 2 + (p.a - q.a) ** 2 + (p.b - q.b) ** 2;

const rad = Math.PI / 180;

/** CIEDE2000 colour difference. */
export function deltaE2000(p: Lab, q: Lab): number {
	const c1 = Math.hypot(p.a, p.b);
	const c2 = Math.hypot(q.a, q.b);
	const cm7 = ((c1 + c2) / 2) ** 7;
	const g = 0.5 * (1 - Math.sqrt(cm7 / (cm7 + 25 ** 7)));
	const a1 = p.a * (1 + g);
	const a2 = q.a * (1 + g);
	const C1 = Math.hypot(a1, p.b);
	const C2 = Math.hypot(a2, q.b);
	const hue = (b: number, a: number) => {
		if (a === 0 && b === 0) return 0;
		const h = Math.atan2(b, a) / rad;
		return h < 0 ? h + 360 : h;
	};
	const h1 = hue(p.b, a1);
	const h2 = hue(q.b, a2);
	const dL = q.l - p.l;
	const dC = C2 - C1;
	let dh = 0;
	if (C1 * C2 !== 0) {
		dh = h2 - h1;
		if (dh > 180) dh -= 360;
		else if (dh < -180) dh += 360;
	}
	const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
	const Lm = (p.l + q.l) / 2;
	const Cm = (C1 + C2) / 2;
	let hm = h1 + h2;
	if (C1 * C2 !== 0) {
		if (Math.abs(h1 - h2) > 180) hm += h1 + h2 < 360 ? 360 : -360;
		hm /= 2;
	}
	const T =
		1 -
		0.17 * Math.cos((hm - 30) * rad) +
		0.24 * Math.cos(2 * hm * rad) +
		0.32 * Math.cos((3 * hm + 6) * rad) -
		0.2 * Math.cos((4 * hm - 63) * rad);
	const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
	const Sc = 1 + 0.045 * Cm;
	const Sh = 1 + 0.015 * Cm * T;
	const Cm7 = Cm ** 7;
	const Rt =
		-2 *
		Math.sqrt(Cm7 / (Cm7 + 25 ** 7)) *
		Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
	return Math.sqrt(
		(dL / Sl) ** 2 +
			(dC / Sc) ** 2 +
			(dH / Sh) ** 2 +
			Rt * (dC / Sc) * (dH / Sh),
	);
}

export const deltaEHex = (x: string, y: string) =>
	deltaE2000(hexToLab(x), hexToLab(y));
