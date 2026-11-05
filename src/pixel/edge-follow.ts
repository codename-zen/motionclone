/** A surface edge candidate on one frame: position along the axis (CSS px), its signed luma step, a divider line. */
export interface EdgeCandidate {
	pos: number;
	step: number;
	line: boolean;
}

/** Which edges are followed: steps lighter on one side, or lines of one polarity. */
export interface Kind {
	sign: number;
	line: boolean;
}

const ofKind = (c: EdgeCandidate, k: Kind) =>
	Math.sign(c.step) === k.sign && c.line === k.line;

/** The element's extent along the axis on one frame, CSS px; null where it has no reading. */
export type Span = { near: number; far: number } | null;

/** Candidates with a step this strong may start an edge; weaker ones only continue one (hysteresis). */
export const START_STEP = 24;
// A continued edge lies within this many CSS px of where it was predicted, plus half its motion against the element.
const TOLERANCE = 3;
const MOTION_SHARE = 0.5;
// An edge that moved less than this on its last step (CSS px) stood still.
const STILL_PX = 0.5;
// Readings this many frames apart, or more, no longer predict each other.
export const STALE = 3;
// The element rests where its box moves less than this between frames, CSS px.
const REST_PX = 0.25;

const gap = (p: number, s: { near: number; far: number }) =>
	Math.max(0, s.near - p, p - s.far);

/**
 * The candidate nearest the element's box that may start an edge (a strong step, or a line), of the given kind when
 * one is given; among equals a step before a line, then the strongest.
 */
function nearest(
	cands: readonly EdgeCandidate[],
	s: { near: number; far: number },
	kind: Kind | null,
): EdgeCandidate | undefined {
	return cands
		.filter(
			(c) =>
				(c.line || Math.abs(c.step) >= START_STEP) &&
				(kind === null || ofKind(c, kind)),
		)
		.sort(
			(a, b) =>
				gap(a.pos, s) - gap(b.pos, s) ||
				Number(a.line) - Number(b.line) ||
				Math.abs(b.step) - Math.abs(a.step),
		)[0];
}

/** The kind of the edge nearest the element where it rests (or anywhere it shows): steps unless lines win the vote. */
function kindOf(
	cands: readonly (readonly EdgeCandidate[] | null)[],
	spans: readonly Span[],
): Kind {
	const lead = (k: number) => spans[k]?.near;
	const rests = spans.map((_, k) =>
		[k - 1, k + 1].some((j) => {
			const a = lead(j);
			const b = lead(k);
			return a !== undefined && b !== undefined && Math.abs(a - b) < REST_PX;
		}),
	);
	const picks = (only: boolean) =>
		cands.flatMap((c, k) => {
			const s = spans[k];
			const e = c && s && (!only || rests[k]) ? nearest(c, s, null) : undefined;
			return e ? [e] : [];
		});
	const seen = picks(true).length > 0 ? picks(true) : picks(false);
	const lines = seen.filter((e) => e.line);
	const line = lines.length > seen.length / 2;
	const sum = (seen.filter((e) => e.line === line) ?? []).reduce(
		(a, e) => a + Math.sign(e.step),
		0,
	);
	return { sign: Math.sign(sum) || 1, line };
}

/**
 * Every kind of edge the frames hold a strong candidate of, the kind of the edge nearest the element at rest first
 * and then by how many frames show one; the caller follows the first whose edge belongs to the element's surface.
 */
export function edgeKinds(
	cands: readonly (readonly EdgeCandidate[] | null)[],
	spans: readonly Span[],
): Kind[] {
	const first = kindOf(cands, spans);
	const counts = new Map<string, { kind: Kind; n: number }>();
	for (const c of cands)
		for (const kind of new Set(
			(c ?? [])
				.filter((e) => e.line || Math.abs(e.step) >= START_STEP)
				.map((e) => `${Math.sign(e.step)}|${e.line}`),
		)) {
			const [sign, line] = kind.split("|");
			const entry = counts.get(kind) ?? {
				kind: { sign: Number(sign), line: line === "true" },
				n: 0,
			};
			entry.n++;
			counts.set(kind, entry);
		}
	const rest = [...counts.values()]
		.filter((e) => e.kind.sign !== first.sign || e.kind.line !== first.line)
		.sort((a, b) => b.n - a.n)
		.map((e) => e.kind);
	return [first, ...rest];
}

/**
 * One surface edge followed through the clip: on each frame the candidate of the same kind nearest to where
 * the edge was predicted, from its last reading moved with the element, or with its own last velocity (an edge that
 * sweeps past content that stays, as a panel revealing it). Weaker steps continue an edge, so it does not flicker to
 * a neighbouring edge when its contrast dips; a frame whose candidates all lie too far from the prediction has no
 * reading. Frames without a reading of the element itself have none either. Until the edge has two recent readings
 * it starts again on each frame at the strong edge nearest to the element's box.
 */
export function followEdge(
	cands: readonly (readonly EdgeCandidate[] | null)[],
	spans: readonly Span[],
	kind: Kind = kindOf(cands, spans),
): (number | null)[] {
	const out: (number | null)[] = cands.map(() => null);
	const seen: { k: number; pos: number }[] = [];
	cands.forEach((c, k) => {
		const s = spans[k];
		if (!c || !s) return;
		const last = seen.at(-1);
		const before = seen.at(-2);
		// Without two recent readings neither the edge's place nor its speed is known: start again.
		const fresh =
			!last || !before || k - last.k > STALE || last.k - before.k > STALE;
		let pick: EdgeCandidate | undefined;
		if (fresh) pick = nearest(c, s, kind);
		else {
			const leadAt = (j: number) => spans[j]?.near ?? s.near;
			const moved = s.near - leadAt(last.k);
			const per = (k - last.k) / (last.k - before.k);
			const step = (
				p: { k: number; pos: number },
				q: { k: number; pos: number },
			) => ({
				edge: (q.pos - p.pos) / (q.k - p.k),
				apart: (q.pos - p.pos - (leadAt(q.k) - leadAt(p.k))) / (q.k - p.k),
			});
			const now = step(before, last);
			const third = seen.at(-3);
			const prev =
				third && before.k - third.k <= STALE ? step(third, before) : null;
			// How far the edge moved apart from the element on its last steps: an edge that rides on the element is
			// predicted from the element alone and exactly; one that moves apart also from its own speed and
			// acceleration, with half the relative motion as slack.
			const apart = Math.max(Math.abs(now.apart), Math.abs(prev?.apart ?? 0));
			const rides = apart * (last.k - before.k) <= TOLERANCE;
			const ahead = k - last.k;
			const v = now.edge * ahead;
			const accel = prev ? (now.edge - prev.edge) * ahead : 0;
			const resting = Math.abs(last.pos - before.pos) <= STILL_PX;
			// A riding edge goes on riding. One that stood still may stay (a trailing panel edge) or leave its rest
			// with the element, up to twice as fast (a leading one); one that moves apart goes on at its own speed.
			const preds = rides
				? [last.pos + moved, ...(resting ? [last.pos] : [])]
				: [last.pos + moved, last.pos + v, last.pos + v + accel];
			const lo = Math.min(last.pos, last.pos + 2 * moved);
			const hi = Math.max(last.pos, last.pos + 2 * moved);
			const leaves = (p: number) => resting && rides && p >= lo && p <= hi;
			const err = (p: number) => Math.min(...preds.map((q) => Math.abs(p - q)));
			const tol =
				TOLERANCE +
				(rides ? 0 : MOTION_SHARE * apart * per * (last.k - before.k));
			pick = c
				.filter((e) => ofKind(e, kind) && (err(e.pos) <= tol || leaves(e.pos)))
				.sort((x, y) => err(x.pos) - err(y.pos))[0];
		}
		if (!pick) return;
		out[k] = pick.pos;
		seen.push({ k, pos: pick.pos });
	});
	return out;
}
