import { describe, expect, it } from "vitest";
import { edgeWarning } from "../src/video/edges.ts";

describe("surface edge warning", () => {
	it("names the edge as its rows name it", () => {
		expect(edgeWarning("blob", 2)).toContain("tracked as blob::edge[2],");
		expect(edgeWarning("blob", 2)).toMatch(/^region blob\[2\]: /);
		expect(edgeWarning("sheet", 0)).toContain("tracked as sheet::edge,");
	});
});
