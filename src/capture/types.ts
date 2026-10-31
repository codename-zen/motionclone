export type AnimationType = "CSSAnimation" | "CSSTransition" | "WebAnimation";

export interface KeyframeInfo {
	offset: number;
	easing: string;
}

interface TimingInfo {
	duration: number | string;
	delay: number;
	endDelay: number;
	iterations: number | "infinite";
	iterationStart: number;
	direction: string;
	fill: string;
	easing: string;
	keyframes: KeyframeInfo[];
}

export interface TrackedMatch {
	selector: string;
	index: number;
}

export interface PageAnimationRecord extends TimingInfo {
	id: number;
	type: AnimationType;
	name: string;
	target: string;
	startMs: number;
	timeline: string;
	playbackRate: number;
	cdpId: string | null;
	nodePath: string | null;
	tracked: TrackedMatch[];
}

export interface CdpAnimation extends TimingInfo {
	cdpId: string;
	type: AnimationType;
	name: string;
	backendNodeId: number | null;
	target: string;
	playbackRate: number;
	timeline: string;
	canceled: boolean;
	events: string[];
}

export interface AnimationRecord extends TimingInfo {
	type: AnimationType;
	name: string;
	target: string;
	/** Unique nth-child path from <html>; null when only CDP saw the animation. */
	nodePath: string | null;
	/** Tracked selectors this target matches, with its index in track.json. */
	tracked: TrackedMatch[];
	startMs: number | null;
	timeline: string;
	playbackRate: number;
	canceled: boolean;
	sources: ("cdp" | "page")[];
	cdp: { id: string; backendNodeId: number | null; events: string[] } | null;
}

export interface TrackedElement {
	index: number;
	x: number;
	y: number;
	w: number;
	h: number;
	opacity: number;
	transform: string;
	filter: string;
	clipPath: string;
	color: string;
	backgroundColor: string;
	boxShadow: string;
}

export interface TrackFrame {
	frame: number;
	t: number;
	scrollY: number;
	elements: Record<string, TrackedElement[]>;
}

export type StackKind =
	| "css-animation"
	| "css-transition"
	| "waapi"
	| "gsap"
	| "motion"
	| "canvas"
	| "webgl"
	| "webgpu"
	| "scroll-driven";

export interface CaptureSummary {
	outDir: string;
	url: string;
	frames: number;
	frameMs: number;
	clip: { x: number; y: number; width: number; height: number };
	animations: number;
	stack: StackKind[];
	warnings: string[];
}
