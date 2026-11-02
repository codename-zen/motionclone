import { describe, expect, it } from "vitest";
import { pickFrames } from "../src/video/extract.ts";
import { parseShowinfo } from "../src/video/ffmpeg.ts";
import { fillLost } from "../src/video/fill.ts";
import { parseTime } from "../src/video/options.ts";
import { parseProbe } from "../src/video/probe.ts";
import { judge } from "../src/video/quality.ts";

describe("video helpers", () => {
	it("parses times", () => {
		expect(parseTime(1.5)).toBe(1.5);
		expect(parseTime("1500ms")).toBe(1.5);
		expect(parseTime("2.25s")).toBe(2.25);
		expect(parseTime("1:02.5")).toBe(62.5);
		expect(parseTime("1:00:01")).toBe(3601);
		expect(() => parseTime("soon")).toThrow();
	});

	it("reads ffmpeg headers without tripping on hex tags", () => {
		const h = parseProbe(
			"  Duration: 00:01:02.50, start: 0.000000, bitrate: 683 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 671 kb/s, 59.94 fps, 59.94 tbr, 90k tbn (default)\n      displaymatrix: rotation of -90.00 degrees",
		);
		expect(h).toEqual({
			durationS: 62.5,
			width: 1080,
			height: 1920,
			codec: "h264",
			fps: 59.94,
			tbr: 59.94,
		});
	});

	it("picks the frame on screen at each grid time, within half a tick", () => {
		// A 30 fps gif: centisecond delays alternate 3 and 4.
		const scan = parseShowinfo(
			[0, 3, 7, 10, 13, 17]
				.map(
					(p, n) =>
						`n: ${n} pts: ${p} pts_time:${p / 100} duration: 3 duration_time:0.03`,
				)
				.join("\n"),
		);
		expect(scan.timeBase).toBeCloseTo(0.01);
		expect(pickFrames(scan, 0, 30, 6)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(pickFrames(scan, 0, 60, 4)).toEqual([0, 0, 1, 1]);
		expect(pickFrames(scan, 0.05, 30, 2)).toEqual([1, 2]);
	});

	it("fills frames where the element was not visible", () => {
		const f = [false, false, true, true, false, true];
		expect(fillLost([0, 0, 10, 6, 0, 2], f)).toEqual([14, 14, 10, 6, 4, 2]);
	});

	it("judges a match against the noise", () => {
		const fit = { cx: 0, cy: 0, s: 1, blur: 0 };
		const at = (ncc: number, contrast: number, spread: number) =>
			judge({ ...fit, ncc, contrast, spread }, 1).status;
		expect(at(0.999, 0.8, 60)).toBe("found");
		// Faint: the residual is within the noise, so a modest correlation still explains the patch.
		expect(at(0.85, 0.1, 1.2)).toBe("faint");
		// A blurred model on an unrelated edge: correlated, but a third of the structure is left over.
		expect(at(0.73, 0.22, 4.8)).toBe("other");
		expect(at(0.4, 0.02, 1)).toBe("absent");
		// More structure than the element at full opacity is something else.
		expect(at(0.995, 1.8, 40)).toBe("other");
	});
});
