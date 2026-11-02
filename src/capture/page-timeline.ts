// Runs in the page before any page script; must stay self-contained because Playwright serializes it.
export function installVirtualTimeline(): void {
	// The frozen timeline stays at 0, so expose the document timeline as virtual time (performance.now)
	// and map startTime onto currentTime; libraries like Motion sync animations through startTime.
	const proto = Animation.prototype;
	const ct = Object.getOwnPropertyDescriptor(
		proto,
		"currentTime",
	) as PropertyDescriptor;
	const st = Object.getOwnPropertyDescriptor(
		proto,
		"startTime",
	) as PropertyDescriptor;
	const touch = (a: Animation): void =>
		(
			window as unknown as { __motioncloneTouch?(a: Animation): void }
		).__motioncloneTouch?.(a);
	const virtual = (a: Animation): boolean =>
		a.timeline === document.timeline && a.playbackRate !== 0;
	Object.defineProperty(proto, "currentTime", {
		configurable: true,
		get: ct.get,
		set(this: Animation, v: CSSNumberish | null) {
			ct.set?.call(this, v);
			touch(this);
		},
	});
	Object.defineProperty(proto, "startTime", {
		configurable: true,
		get(this: Animation) {
			const cur = ct.get?.call(this) as number | null;
			if (
				!virtual(this) ||
				cur === null ||
				this.playState === "paused" ||
				this.playState === "idle"
			) {
				return st.get?.call(this);
			}
			return performance.now() - cur / this.playbackRate;
		},
		set(this: Animation, v: CSSNumberish | null) {
			if (!virtual(this) || v === null) {
				st.set?.call(this, v);
				return;
			}
			// Setting a start time makes an idle or paused animation run; setting currentTime alone would not.
			const resume = this.playState === "paused" || this.playState === "idle";
			ct.set?.call(
				this,
				(performance.now() - (v as number)) * this.playbackRate,
			);
			if (resume) this.play();
			touch(this);
		},
	});
	const tl = Object.getOwnPropertyDescriptor(
		AnimationTimeline.prototype,
		"currentTime",
	) as PropertyDescriptor;
	Object.defineProperty(DocumentTimeline.prototype, "currentTime", {
		configurable: true,
		get(this: AnimationTimeline) {
			return this === document.timeline
				? performance.now()
				: tl.get?.call(this);
		},
	});
}
