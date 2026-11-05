import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { differenceImage } from "../src/media/image.ts";

describe("differenceImage", () => {
	it("is black where frames match and red where they differ, as both sheets draw it", () => {
		const a = new PNG({ width: 20, height: 10 });
		for (let i = 0; i < a.data.length; i += 4)
			a.data.set([(i / 4) % 255, 120, 200, 255], i);
		const b = PNG.sync.read(PNG.sync.write(a));
		b.data.set([255, 255, 255, 255], 0);
		const same = differenceImage(a, a);
		expect([...same.data].filter((v, i) => i % 4 !== 3 && v !== 0)).toEqual([]);
		const diff = differenceImage(a, b);
		expect([...diff.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
		expect([...diff.data.subarray(4, 8)]).toEqual([0, 0, 0, 255]);
	});
});
