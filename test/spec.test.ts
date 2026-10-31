import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Answer, type AnswerRow } from "../fixtures/answer-schema.ts";
import { FIRST_FRAME_MS } from "../src/capture/index.ts";
import { dampingRatio } from "../src/fit/spring.ts";
import { draftSpec } from "../src/spec/draft.ts";
import {
	bezierEasing,
	curveSpanMs,
	parseCssEasing,
	springEasing,
	unitCurve,
} from "../src/spec/easing.ts";
import {
	DEFAULT_TOLERANCES,
	type Easing,
	SpecFile,
	type SpecRow,
} from "../src/spec/schema.ts";
import {
	type CaptureSession,
	FADE,
	GSAP,
	openCaptureSession,
	SPRING,
} from "./capture-session.ts";
import { maxDeviation } from "./synth.ts";

describe("parseCssEasing", () => {
	it("names keywords and known curves", () => {
		expect(parseCssEasing("ease-in")).toMatchObject({ name: "ease-in" });
		expect(parseCssEasing("cubic-bezier(0.16, 1, 0.3, 1)")).toMatchObject({
			type: "cubic-bezier",
			name: "easeOutExpo",
		});
		expect(parseCssEasing("linear")).toEqual({ type: "linear" });
	});

	it("reads steps and rejects point lists", () => {
		expect(parseCssEasing("steps(4, jump-end)")).toEqual({
			type: "steps",
			count: 4,
			position: "end",
		});
		expect(parseCssEasing("step-start")).toMatchObject({ position: "start" });
		expect(parseCssEasing("linear(0, 0.5 20%, 1)")).toBeNull();
	});
});

const answerEasing = (row: AnswerRow): Easing => {
	switch (row.easing.type) {
		case "cubic-bezier":
			return bezierEasing(row.easing.p);
		case "spring":
			return springEasing(row.easing);
		case "steps":
			return row.easing;
		case "linear":
			return { type: "linear" };
	}
};

const timed = (e: Easing, startMs: number, durationMs: number) => {
	const curve = unitCurve(e);
	const span = curveSpanMs(e, durationMs);
	return (t: number) => curve((t - startMs) / span);
};

/** Compare a drafted row with its answer row using the default verify tolerances. */
function expectMatches(
	row: SpecRow,
	key: AnswerRow,
	keyStart: number,
	frameMs: number,
) {
	const tol = (v: number) => Math.max(v, frameMs);
	const dev = maxDeviation(
		timed(row.easing, row.startMs, row.durationMs),
		timed(answerEasing(key), keyStart, key.durationMs),
		keyStart - 60,
		keyStart + key.durationMs + 300,
	);
	const wantDist = Math.abs(Number(key.to) - Number(key.from));
	console.log(
		`${row.id} (${row.source}): start ${row.startMs} vs ${keyStart}, duration ${row.durationMs} vs ${key.durationMs}, curve dev ${dev.toFixed(4)}`,
	);
	expect(Math.abs(row.startMs - keyStart)).toBeLessThanOrEqual(
		tol(DEFAULT_TOLERANCES.startMs),
	);
	expect(Math.abs(row.durationMs - key.durationMs)).toBeLessThanOrEqual(
		tol(DEFAULT_TOLERANCES.durationMs),
	);
	expect(dev).toBeLessThanOrEqual(DEFAULT_TOLERANCES.easing);
	expect(
		Math.abs(Math.abs(row.to - row.from) / wantDist - 1),
	).toBeLessThanOrEqual(DEFAULT_TOLERANCES.distance);
	expect(Math.sign(row.to - row.from)).toBe(
		Math.sign(Number(key.to) - Number(key.from)),
	);
}

describe("draftSpec on reference captures", () => {
	let session: CaptureSession;
	beforeAll(async () => {
		session = await openCaptureSession("spec");
	});
	afterAll(async () => {
		await session?.close();
	});

	const answerOf = async (name: string) =>
		Answer.parse(
			JSON.parse(await readFile(`fixtures/${name}/answer.json`, "utf8")),
		);

	const keyFor = (answer: Answer, row: SpecRow) => {
		const key = answer.rows.find(
			(k) =>
				k.selector === row.selector &&
				k.index === row.index &&
				k.property === row.property,
		);
		if (!key) throw new Error(`no answer row for ${row.id}`);
		return key;
	};

	it("css-fade-up-stagger: declared rows, stagger and the still title", async () => {
		const dir = await session.capture("css-fade-up-stagger", "fade", FADE);
		const spec = await draftSpec(dir);
		const answer = await answerOf("css-fade-up-stagger");
		expect(spec.rows.map((r) => r.id).sort()).toEqual(
			answer.rows.map((k) => `.card[${k.index}].${k.property}`).sort(),
		);
		for (const row of spec.rows) {
			expect(row.source).toBe("declared");
			const key = keyFor(answer, row);
			expectMatches(row, key, key.startMs, spec.meta.frameMs);
			// Declared values are exact, not fitted.
			expect(row.startMs).toBe(key.startMs);
			expect(row.durationMs).toBe(key.durationMs);
			if (row.index > 0) expect(row.stagger?.gapMs).toBe(90);
		}
		expect(spec.still.map((s) => s.id)).toEqual(["h1[0]"]);
		const written = SpecFile.parse(
			JSON.parse(await readFile(join(dir, "spec.json"), "utf8")),
		);
		expect(written).toEqual(spec);
	});

	it("gsap-timeline: measured rows match the key, shifted by FIRST_FRAME_MS", async () => {
		const dir = await session.capture("gsap-timeline", "gsap", GSAP);
		const spec = await draftSpec(dir);
		const answer = await answerOf("gsap-timeline");
		expect(spec.rows).toHaveLength(answer.rows.length);
		expect(spec.meta.stack).toContain("gsap");
		for (const row of spec.rows) {
			expect(row.source).toBe("measured");
			const key = keyFor(answer, row);
			// JS timelines count from script time, which is FIRST_FRAME_MS before t=0 (see ADR 0001).
			expectMatches(row, key, key.startMs - FIRST_FRAME_MS, spec.meta.frameMs);
		}
	});

	it("motion-spring: a measured spring with the keyed damping ratio", async () => {
		const dir = await session.capture("motion-spring", "spring", SPRING);
		const spec = await draftSpec(dir);
		const answer = await answerOf("motion-spring");
		expect(spec.rows).toHaveLength(1);
		const row = spec.rows[0] as SpecRow;
		const key = keyFor(answer, row);
		if (row.easing.type !== "spring" || key.easing.type !== "spring")
			throw new Error(`not a spring: ${JSON.stringify(row.easing)}`);
		expect(row.source).toBe("measured");
		// The Motion WAAPI animation is canceled and handed to JS, so it is never the declared source.
		expect(row.notes.join(" ")).not.toContain("declared");
		expect(
			Math.abs(row.easing.zeta / dampingRatio(key.easing) - 1),
		).toBeLessThan(0.1);
		expect(row.overshoot).toBeGreaterThan(0.08);
		expectMatches(row, key, key.startMs, spec.meta.frameMs);
	});
});
