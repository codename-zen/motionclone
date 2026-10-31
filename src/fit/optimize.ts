export interface Minimum {
	x: number[];
	fx: number;
}

interface Options {
	maxIter?: number;
	tol?: number;
}

function simplexRun(
	f: (x: number[]) => number,
	x0: number[],
	step: number[],
	maxIter: number,
	tol: number,
): Minimum {
	const n = x0.length;
	const pts: Minimum[] = [{ x: x0, fx: f(x0) }];
	for (let i = 0; i < n; i++) {
		const x = x0.slice();
		x[i] = (x[i] ?? 0) + (step[i] ?? 1);
		pts.push({ x, fx: f(x) });
	}
	const point = (c: number[], from: number[], k: number) =>
		c.map((v, i) => v + k * ((from[i] ?? 0) - v));
	for (let iter = 0; iter < maxIter; iter++) {
		pts.sort((a, b) => a.fx - b.fx);
		const best = pts[0] as Minimum;
		const worst = pts[n] as Minimum;
		if (Math.abs(worst.fx - best.fx) < tol) break;
		const centroid = new Array<number>(n).fill(0);
		for (let i = 0; i < n; i++)
			for (let j = 0; j < n; j++)
				centroid[j] = (centroid[j] ?? 0) + (pts[i]?.x[j] ?? 0) / n;
		const make = (k: number): Minimum => {
			const x = point(centroid, worst.x, k);
			return { x, fx: f(x) };
		};
		const refl = make(-1);
		if (refl.fx < best.fx) {
			const exp = make(-2);
			pts[n] = exp.fx < refl.fx ? exp : refl;
		} else if (refl.fx < (pts[n - 1] as Minimum).fx) {
			pts[n] = refl;
		} else {
			const con = refl.fx < worst.fx ? make(-0.5) : make(0.5);
			if (con.fx < Math.min(refl.fx, worst.fx)) {
				pts[n] = con;
			} else {
				for (let i = 1; i <= n; i++) {
					const p = pts[i] as Minimum;
					const x = point(best.x, p.x, 0.5);
					pts[i] = { x, fx: f(x) };
				}
			}
		}
	}
	pts.sort((a, b) => a.fx - b.fx);
	return pts[0] as Minimum;
}

/** Nelder-Mead with one restart from the first optimum, which escapes most collapsed simplexes. */
export function nelderMead(
	f: (x: number[]) => number,
	x0: number[],
	step: number[],
	{ maxIter = 500, tol = 1e-12 }: Options = {},
): Minimum {
	const first = simplexRun(f, x0, step, maxIter, tol);
	const second = simplexRun(
		f,
		first.x,
		step.map((s) => s * 0.5),
		maxIter,
		tol,
	);
	return second.fx <= first.fx ? second : first;
}
