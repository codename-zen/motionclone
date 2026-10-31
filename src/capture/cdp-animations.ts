import type { CDPSession } from "playwright";
import type { AnimationType, CdpAnimation } from "./types.ts";

interface CdpEffect {
	delay: number;
	endDelay: number;
	iterationStart: number;
	iterations?: number;
	duration: number;
	direction: string;
	fill: string;
	backendNodeId?: number;
	keyframesRule?: {
		name?: string;
		keyframes: { offset: string; easing: string }[];
	};
	easing: string;
}

interface CdpAnimationPayload {
	id: string;
	name: string;
	playbackRate: number;
	startTime: number;
	type: AnimationType;
	source?: CdpEffect;
	viewOrScrollTimeline?: { subjectNodeId?: number };
}

interface NodeDescription {
	node: {
		nodeName: string;
		attributes?: string[];
		pseudoType?: string;
		parentId?: number;
	};
}

export interface CdpRecorder {
	finish(): Promise<{ animations: CdpAnimation[]; createdOnly: string[] }>;
}

function describeNode({ node }: NodeDescription): string {
	const attrs = node.attributes ?? [];
	const get = (name: string): string | undefined => {
		const i = attrs.indexOf(name);
		return i >= 0 && i % 2 === 0 ? attrs[i + 1] : undefined;
	};
	let out = node.nodeName.toLowerCase();
	const id = get("id");
	if (id) out += `#${id}`;
	for (const c of (get("class") ?? "").split(/\s+/)) if (c) out += `.${c}`;
	return out;
}

function timelineOf(a: CdpAnimationPayload): string {
	if (!a.viewOrScrollTimeline) return "document";
	return a.viewOrScrollTimeline.subjectNodeId === undefined ? "scroll" : "view";
}

// Tags the page-side Animation object with its CDP id so both records can be joined later.
async function tagInPage(cdp: CDPSession, animationId: string): Promise<void> {
	const { remoteObject } = await cdp.send("Animation.resolveAnimation", {
		animationId,
	});
	if (!remoteObject.objectId) return;
	await cdp.send("Runtime.callFunctionOn", {
		objectId: remoteObject.objectId,
		functionDeclaration:
			"function (id) { if (window.__motionclone) window.__motionclone.tagCdp(this, id); }",
		arguments: [{ value: animationId }],
	});
}

// Enables the Animation domain and freezes the document timeline; call before navigation.
export async function startCdpRecorder(cdp: CDPSession): Promise<CdpRecorder> {
	const byId = new Map<string, CdpAnimation>();
	// resolveAnimation reuses one object group, so each handle must be used before the next resolve.
	let tagChain: Promise<unknown> = Promise.resolve();
	const pending: Promise<unknown>[] = [];
	const pendingCreated = new Set<string>();

	const entry = (id: string): CdpAnimation | undefined => byId.get(id);

	const upsert = (a: CdpAnimationPayload, event: string): void => {
		const known = entry(a.id);
		const src = a.source;
		const iterations = src?.iterations;
		const next: CdpAnimation = {
			cdpId: a.id,
			type: a.type,
			name: a.name,
			backendNodeId: src?.backendNodeId ?? null,
			target: known?.target ?? "(unresolved)",
			playbackRate: a.playbackRate,
			timeline: timelineOf(a),
			canceled: known?.canceled ?? false,
			events:
				known?.events.at(-1) === event
					? known.events
					: [...(known?.events ?? []), event],
			duration: src?.duration ?? 0,
			delay: src?.delay ?? 0,
			endDelay: src?.endDelay ?? 0,
			iterations:
				iterations === undefined || Number.isFinite(iterations)
					? (iterations ?? 1)
					: "infinite",
			iterationStart: src?.iterationStart ?? 0,
			direction: src?.direction ?? "normal",
			fill: src?.fill ?? "auto",
			easing: src?.easing ?? "linear",
			keyframes: (src?.keyframesRule?.keyframes ?? []).map((k) => ({
				offset: Number.parseFloat(k.offset) / 100,
				easing: k.easing,
			})),
		};
		byId.set(a.id, next);
		if (known) return;
		const nodeId = src?.backendNodeId;
		if (nodeId !== undefined) {
			pending.push(
				cdp
					.send("DOM.describeNode", { backendNodeId: nodeId })
					.then((d) => {
						const cur = entry(a.id);
						if (cur) cur.target = describeNode(d as NodeDescription);
					})
					.catch(() => undefined),
			);
		}
		tagChain = tagChain.then(() => tagInPage(cdp, a.id)).catch(() => undefined);
	};

	cdp.on("Animation.animationCreated", (e: { id: string }) => {
		if (!byId.has(e.id)) pendingCreated.add(e.id);
	});
	cdp.on(
		"Animation.animationStarted",
		(e: { animation: CdpAnimationPayload }) => {
			pendingCreated.delete(e.animation.id);
			upsert(e.animation, "started");
		},
	);
	cdp.on(
		"Animation.animationUpdated",
		(e: { animation: CdpAnimationPayload }) => {
			pendingCreated.delete(e.animation.id);
			upsert(e.animation, "updated");
		},
	);
	cdp.on("Animation.animationCanceled", (e: { id: string }) => {
		const cur = entry(e.id);
		if (cur) {
			cur.canceled = true;
			cur.events.push("canceled");
		}
	});
	await cdp.send("Animation.enable");
	await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });

	return {
		async finish() {
			await Promise.all([...pending, tagChain]);
			return {
				animations: [...byId.values()],
				createdOnly: [...pendingCreated],
			};
		},
	};
}
