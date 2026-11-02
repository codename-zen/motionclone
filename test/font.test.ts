import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { drawText, textWidth, wrapText } from "../src/report/font.ts";

const hash = (img: PNG) =>
	createHash("sha1").update(img.data).digest("hex").slice(0, 16);

function render(text: string, scale = 2) {
	const img = new PNG({ width: textWidth(text, scale), height: 7 * scale });
	drawText(img, text, 0, 0, [255, 255, 255], scale);
	return img;
}

describe("bitmap font", () => {
	it("renders a short string to a stable image", () => {
		const img = render("Clone 12 ms");
		expect([img.width, img.height]).toEqual([132, 14]);
		expect(hash(img)).toBe("529232d7cfb270eb");
	});

	it("draws something for every printable character and '?' for others", () => {
		for (let c = 33; c <= 126; c++)
			expect(render(String.fromCharCode(c), 1).data.some((v) => v > 0)).toBe(
				true,
			);
		expect(hash(render("é"))).toBe(hash(render("?")));
	});

	it("clips text that runs past the image", () => {
		const img = new PNG({ width: 10, height: 5 });
		expect(() => drawText(img, "wide text", 4, 2, [255, 0, 0])).not.toThrow();
	});

	it("wraps words and hard-breaks long ones", () => {
		expect(wrapText("aa bb cc dd", 5)).toEqual(["aa bb", "cc dd"]);
		expect(wrapText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
	});
});
