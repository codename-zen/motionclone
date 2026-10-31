import { runFfmpeg, scanFrames } from "./ffmpeg.ts";

export interface VideoProbe {
	path: string;
	/** Seconds; null when the container does not say. */
	durationS: number | null;
	width: number;
	height: number;
	fps: number;
	codec: string;
	/** True when fps was measured from frame timestamps (gif delays) rather than read from the header. */
	fpsFromFrames: boolean;
}

export interface ParsedHeader {
	durationS: number | null;
	width: number;
	height: number;
	codec: string;
	fps: number | null;
	tbr: number | null;
}

const num = (s: string | undefined): number | null => {
	if (!s) return null;
	const v = s.endsWith("k") ? Number(s.slice(0, -1)) * 1000 : Number(s);
	return Number.isFinite(v) && v > 0 ? v : null;
};

/** Read the first video stream from `ffmpeg -i` stderr. */
export function parseProbe(stderr: string): ParsedHeader {
	const stream = /Stream #\d+:\d+[^\n]*?: Video: ([^\n]*)/.exec(stderr)?.[1];
	if (!stream) throw new Error("no video stream found");
	// The size is the first WxH token between commas; hex tags like 0x31637661 sit inside parentheses.
	const size = /(?:^|,\s*)(\d{1,5})x(\d{1,5})(?=$|[\s,[])/.exec(stream);
	if (!size) throw new Error(`cannot read the frame size from: ${stream}`);
	let width = Number(size[1]);
	let height = Number(size[2]);
	const rotation = /rotation of (-?[\d.]+) degrees/.exec(stderr)?.[1];
	if (rotation && Math.abs(Math.round(Number(rotation) / 90)) % 2 === 1)
		[width, height] = [height, width];
	const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
	return {
		durationS: d
			? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])
			: null,
		width,
		height,
		codec: /^(\w+)/.exec(stream)?.[1] ?? "unknown",
		fps: num(/([\d.]+k?) fps/.exec(stream)?.[1]),
		tbr: num(/([\d.]+k?) tbr/.exec(stream)?.[1]),
	};
}

// Gif delays are whole centiseconds, so a 30 fps gif alternates 3 and 4 cs; the mean rate is snapped when within 1 %.
function snap(fps: number): number {
	const whole = Math.round(fps);
	return Math.abs(fps - whole) <= 0.01 * fps ? whole : Number(fps.toFixed(3));
}

export async function probeVideo(path: string): Promise<VideoProbe> {
	const { stderr } = await runFfmpeg(["-i", path]);
	if (!/Input #0/.test(stderr))
		throw new Error(
			`cannot read ${path}: ${stderr.trim().split(/\r?\n/).at(-1) ?? "unknown error"}`,
		);
	const h = parseProbe(stderr);
	if (h.codec === "gif" || !(h.fps ?? h.tbr)) {
		const { frames } = await scanFrames(path);
		const last = frames.at(-1);
		const span = last?.t ?? 0;
		const fps =
			frames.length > 1 && span > 0
				? snap((frames.length - 1) / span)
				: (h.fps ?? h.tbr ?? 0);
		if (!(fps > 0)) throw new Error(`cannot tell the frame rate of ${path}`);
		const end = (last?.t ?? 0) + (last?.duration || 1 / fps);
		return {
			path,
			...pick(h),
			durationS: h.durationS ?? end,
			fps,
			fpsFromFrames: true,
		};
	}
	return {
		path,
		...pick(h),
		fps: (h.fps ?? h.tbr) as number,
		fpsFromFrames: false,
	};
}

const pick = ({ durationS, width, height, codec }: ParsedHeader) => ({
	durationS,
	width,
	height,
	codec,
});
