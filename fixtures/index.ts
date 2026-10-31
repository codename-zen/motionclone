import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Answer } from "./answer-schema.ts";

export interface Fixture {
	dir: string;
	answer: Answer;
}

export function listFixtures(): Fixture[] {
	const root = import.meta.dirname;
	return readdirSync(root, { withFileTypes: true })
		.filter(
			(d) => d.isDirectory() && existsSync(join(root, d.name, "answer.json")),
		)
		.map((d) => ({
			dir: d.name,
			answer: Answer.parse(
				JSON.parse(readFileSync(join(root, d.name, "answer.json"), "utf8")),
			),
		}));
}
