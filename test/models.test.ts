import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
	DEFAULT_MODELS,
	formatModelDisplayName,
	parseOpenDesignModels,
	type OpenDesignApiModel,
} from "../models.ts";

describe("OpenDesign Models", () => {
	test("provides static default models matching OpenDesign catalog", () => {
		assert.ok(DEFAULT_MODELS.length >= 11, "Catalog should have at least 11 models");
		
		const deepseek = DEFAULT_MODELS.find((m) => m.id === "deepseek-v4.1-flash");
		assert.ok(deepseek, "deepseek-v4.1-flash must exist");
		assert.equal(deepseek.name, "DeepSeek V4.1 Flash");
		assert.deepEqual(deepseek.input, ["text", "image"]);
		assert.equal(deepseek.contextWindow, 1048000);
		assert.equal(deepseek.maxTokens, 32000);
		assert.equal(deepseek.reasoning, true);

		const haiku = DEFAULT_MODELS.find((m) => m.id === "claude-haiku-5.5");
		assert.ok(haiku, "claude-haiku-5.5 must exist");
		assert.equal(haiku.name, "Claude Haiku 5.5");
		assert.deepEqual(haiku.input, ["text", "image"]);
	});

	test("formats model ids into clean display names", () => {
		assert.equal(formatModelDisplayName("deepseek-v4.1-flash"), "DeepSeek V4.1 Flash");
		assert.equal(formatModelDisplayName("claude-haiku-5.5"), "Claude Haiku 5.5");
		assert.equal(formatModelDisplayName("glm-5.3-flashx"), "GLM 5.3 Flashx");
		assert.equal(formatModelDisplayName("gpt-6-luna"), "GPT 6 Luna");
		assert.equal(formatModelDisplayName("kimi-k2.7-code"), "Kimi K2.7 Code");
		assert.equal(formatModelDisplayName("mimo-v2.6-pro"), "Mimo V2.6 Pro");
	});

	test("parses live /v1/models response correctly", () => {
		const sampleApiResponse: { data: OpenDesignApiModel[]; object: string } = {
			object: "list",
			data: [
				{
					id: "deepseek-v4.1-flash",
					object: "model",
					created: 1789026056,
					owned_by: "vela",
					architecture: {
						input_modalities: ["text", "image"],
						output_modalities: ["text"],
					},
					metadata: {
						cost: "low",
						capability: "advanced",
						context_limit: 1048000,
						context_budget: 232000,
						output_budget: 32000,
					},
					default: true,
					enabled: true,
				},
				{
					id: "disabled-model",
					object: "model",
					created: 1789026056,
					owned_by: "vela",
					architecture: {
						input_modalities: ["text"],
						output_modalities: ["text"],
					},
					metadata: {
						cost: "low",
						capability: "standard",
						context_limit: 100000,
						context_budget: 10000,
						output_budget: 4000,
					},
					default: false,
					enabled: false,
				},
			],
		};

		const parsed = parseOpenDesignModels(sampleApiResponse);
		assert.equal(parsed.length, 1, "Disabled model should be filtered out");
		assert.equal(parsed[0]?.id, "deepseek-v4.1-flash");
		assert.equal(parsed[0]?.name, "DeepSeek V4.1 Flash");
		assert.equal(parsed[0]?.contextWindow, 1048000);
		assert.equal(parsed[0]?.maxTokens, 32000);
		assert.deepEqual(parsed[0]?.input, ["text", "image"]);
	});

	test("handles invalid or unexpected api payload gracefully", () => {
		assert.deepEqual(parseOpenDesignModels(null), []);
		assert.deepEqual(parseOpenDesignModels(undefined), []);
		assert.deepEqual(parseOpenDesignModels("not-an-object"), []);
		assert.deepEqual(parseOpenDesignModels({}), []);
		assert.deepEqual(parseOpenDesignModels({ data: "not-an-array" }), []);
	});
});
