// Runs in the page after the fake clock is installed; must stay self-contained because Playwright serializes it.
export function installRafFlush(): void {
	// A real browser runs pending rAF callbacks before every paint; the fake clock only fires them on
	// its own 16 ms grid, so each captured frame flushes them (GSAP's first render waits for a tick).
	const fakeRaf = window.requestAnimationFrame.bind(window);
	const fakeCancel = window.cancelAnimationFrame.bind(window);
	const pendingRaf = new Map<
		number,
		{ cb: FrameRequestCallback; inner: number }
	>();
	let rafSeq = 0;
	window.requestAnimationFrame = (cb) => {
		const id = ++rafSeq;
		const inner = fakeRaf((ts) => {
			if (pendingRaf.delete(id)) cb(ts);
		});
		pendingRaf.set(id, { cb, inner });
		return id;
	};
	window.cancelAnimationFrame = (id) => {
		const p = pendingRaf.get(id);
		if (!p) return;
		pendingRaf.delete(id);
		fakeCancel(p.inner);
	};
	const flushRaf = (now: number): void => {
		const batch = [...pendingRaf.values()];
		pendingRaf.clear();
		for (const p of batch) {
			fakeCancel(p.inner);
			try {
				p.cb(now);
			} catch (e) {
				reportError(e);
			}
		}
	};
	Object.defineProperty(window, "__motioncloneFlushRaf", {
		value: flushRaf,
		enumerable: false,
	});
}
