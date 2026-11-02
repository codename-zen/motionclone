import type {
	AnimationRecord,
	CdpAnimation,
	PageAnimationRecord,
} from "./types.ts";

function fromPage(p: PageAnimationRecord): AnimationRecord {
	const { id: _id, cdpId: _cdpId, ...rest } = p;
	return { ...rest, canceled: false, sources: ["page"], cdp: null };
}

function fromCdp(
	c: CdpAnimation,
	page: PageAnimationRecord | undefined,
): AnimationRecord {
	return {
		type: c.type,
		name: c.name,
		target: c.target,
		properties: page?.properties ?? [],
		nodePath: page?.nodePath ?? null,
		tracked: page?.tracked ?? [],
		startMs: page?.startMs ?? null,
		timeline: c.timeline,
		playbackRate: c.playbackRate,
		canceled: c.canceled,
		sources: page ? ["cdp", "page"] : ["cdp"],
		cdp: { id: c.cdpId, events: c.events },
		// Scroll-driven durations are percentages over CDP; the page reports "auto", which is the honest value.
		duration: c.timeline !== "document" && page ? page.duration : c.duration,
		delay: c.delay,
		endDelay: c.endDelay,
		iterations: c.iterations,
		iterationStart: c.iterationStart,
		direction: c.direction,
		fill: c.fill,
		easing: c.easing,
		keyframes: c.keyframes.length > 0 ? c.keyframes : (page?.keyframes ?? []),
	};
}

const sortKey = (r: AnimationRecord): string =>
	[r.nodePath ?? "", r.target, r.type, r.name, r.delay, r.cdp?.id ?? ""].join(
		"|",
	);

function compare(a: AnimationRecord, b: AnimationRecord): number {
	const sa = a.startMs ?? Number.POSITIVE_INFINITY;
	const sb = b.startMs ?? Number.POSITIVE_INFINITY;
	if (sa !== sb) return sa - sb;
	const ka = sortKey(a);
	const kb = sortKey(b);
	return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// CDP is the primary source; page records fill in start times and anything CDP missed.
export function mergeAnimations(
	cdp: CdpAnimation[],
	page: PageAnimationRecord[],
): AnimationRecord[] {
	const pageByCdp = new Map(
		page.flatMap((p) => (p.cdpId === null ? [] : [[p.cdpId, p] as const])),
	);
	const linked = new Set<number>();
	const out: AnimationRecord[] = [];
	for (const c of cdp) {
		const p = pageByCdp.get(c.cdpId);
		if (p) linked.add(p.id);
		out.push(fromCdp(c, p));
	}
	for (const p of page) if (!linked.has(p.id)) out.push(fromPage(p));
	return out.sort(compare);
}
