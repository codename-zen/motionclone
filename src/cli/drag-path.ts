import { UsageError } from "./usage-error.ts";

/** "x,y@ms x,y@ms": a drag path relative to the target's centre. */
export function dragPathOf(text: string) {
	const points = text.trim().split(/\s+/);
	return points.map((p) => {
		const m = /^(-?[\d.]+),(-?[\d.]+)@([\d.]+)$/.exec(p);
		const [x, y, atMs] = (m?.slice(1) ?? []).map(Number);
		if (!m || ![x, y, atMs].every((n) => Number.isFinite(n)))
			throw new UsageError(
				`--drag: cannot read "${p}"; write points as x,y@ms, such as 0,300@1300`,
			);
		return { x: x as number, y: y as number, atMs: atMs as number };
	});
}
