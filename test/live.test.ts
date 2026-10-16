import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import {
	normalizeContext,
	type Model,
	openAICompletionsApi,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { refreshOpenDesignModels } from "../index.ts";
import {
	OPENDESIGN_API_KEY_ENV,
	OPENDESIGN_BASE_URL,
	OPENDESIGN_PROVIDER_ID,
} from "../models.ts";

function getLiveApiKey(): string | undefined {
	const fromEnv = process.env[OPENDESIGN_API_KEY_ENV]?.trim();
	if (fromEnv) return fromEnv;

	const externalKeyPath = join(process.cwd(), "..", "opendesigntestkey.txt");
	if (existsSync(externalKeyPath)) {
		return readFileSync(externalKeyPath, "utf-8").trim();
	}
	return undefined;
}

describe("OpenDesign Live API Integration", () => {
	const apiKey = getLiveApiKey();

	test("fetches live models from OpenDesign API endpoint", async (t) => {
		if (!apiKey) {
			t.skip("No OpenDesign API key found. Set OPENDESIGN_API_KEY or provide ../opendesigntestkey.txt.");
			return;
		}

		const context: RefreshModelsContext = {
			allowNetwork: true,
			signal: AbortSignal.timeout(10_000),
			credential: { type: "api_key", key: apiKey },
			publish: async () => true,
		};

		const models = await refreshOpenDesignModels(context, OPENDESIGN_BASE_URL);
		assert.ok(models.length >= 5, "Expected multiple models from live endpoint");

		const flash = models.find((m) => m.id === "deepseek-v4.1-flash");
		assert.ok(flash, "Live models should include deepseek-v4.1-flash");
		assert.equal(flash.name, "DeepSeek V4.1 Flash");
	});

	test("streams completion from live OpenDesign endpoint", async (t) => {
		if (!apiKey) {
			t.skip("No OpenDesign API key found. Set OPENDESIGN_API_KEY or provide ../opendesigntestkey.txt.");
			return;
		}

		const model: Model<"openai-completions"> = {
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			provider: OPENDESIGN_PROVIDER_ID,
			baseUrl: OPENDESIGN_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048000,
			maxTokens: 32000,
		};

		const context: TranscriptContext = normalizeContext({
			messages: [
				{
					role: "user",
					content: "Reply with the word PONG and nothing else.",
					timestamp: Date.now(),
				},
			],
		});

		const stream = openAICompletionsApi().streamSimple(model, context, {
			apiKey,
			maxTokens: 20,
		});

		let text = "";
		let completed = false;

		for await (const event of stream) {
			if (event.type === "text_delta") {
				text += event.delta;
			} else if (event.type === "done") {
				completed = true;
			} else if (event.type === "error") {
				assert.fail(`Stream returned error: ${event.error.errorMessage}`);
			}
		}

		assert.ok(completed, "Stream should complete successfully");
		assert.ok(text.toUpperCase().includes("PONG"), `Expected text to contain PONG, got: ${text}`);
	});
});
