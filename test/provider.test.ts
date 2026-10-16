import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { describe } from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import extensionFactory, {
	createOpenDesignProviderConfig,
	refreshOpenDesignModels,
} from "../index.ts";
import {
	DEFAULT_MODELS,
	OPENDESIGN_API_KEY_ENV,
	OPENDESIGN_BASE_URL,
	OPENDESIGN_PROVIDER_ID,
	OPENDESIGN_PROVIDER_NAME,
} from "../models.ts";

function createMockRefreshContext(overrides?: Partial<RefreshModelsContext>): RefreshModelsContext {
	return {
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async () => true,
		...overrides,
	};
}

describe("OpenDesign Provider Extension", () => {
	test("creates valid ProviderConfig for OpenDesign", () => {
		const config = createOpenDesignProviderConfig();

		assert.equal(config.name, OPENDESIGN_PROVIDER_NAME);
		assert.equal(config.baseUrl, OPENDESIGN_BASE_URL);
		assert.equal(config.apiKey, `$${OPENDESIGN_API_KEY_ENV}`);
		assert.equal(config.api, "openai-completions");
		assert.ok(Array.isArray(config.models));
		assert.equal(config.models.length, DEFAULT_MODELS.length);
		assert.equal(typeof config.refreshModels, "function");
	});

	test("registers provider with ExtensionAPI", () => {
		let registeredId: string | undefined;
		let registeredConfig: ProviderConfig | undefined;

		const mockPi: Partial<ExtensionAPI> = {
			registerProvider: ((
				providerOrName: string | Parameters<ExtensionAPI["registerProvider"]>[0],
				config?: ProviderConfig,
			): void => {
				if (typeof providerOrName === "string" && config) {
					registeredId = providerOrName;
					registeredConfig = config;
				}
			}) as ExtensionAPI["registerProvider"],
		};

		extensionFactory(mockPi as ExtensionAPI);

		assert.equal(registeredId, OPENDESIGN_PROVIDER_ID);
		assert.equal(registeredConfig?.name, OPENDESIGN_PROVIDER_NAME);
		assert.equal(registeredConfig?.baseUrl, OPENDESIGN_BASE_URL);
		assert.equal(registeredConfig?.apiKey, `$${OPENDESIGN_API_KEY_ENV}`);
		assert.equal(registeredConfig?.api, "openai-completions");
	});

	test("refreshModels returns default models when allowNetwork is false", async () => {
		const context = createMockRefreshContext({ allowNetwork: false });
		const models = await refreshOpenDesignModels(context);
		assert.deepEqual(models, DEFAULT_MODELS);
	});

	test("refreshModels returns default models when no api key exists", async () => {
		const prev = process.env[OPENDESIGN_API_KEY_ENV];
		delete process.env[OPENDESIGN_API_KEY_ENV];
		try {
			const context = createMockRefreshContext({
				allowNetwork: true,
				credential: undefined,
			});
			const models = await refreshOpenDesignModels(context);
			assert.deepEqual(models, DEFAULT_MODELS);
		} finally {
			if (prev !== undefined) process.env[OPENDESIGN_API_KEY_ENV] = prev;
		}
	});

	test("refreshModels fetches and parses models from endpoint using credential", async () => {
		let capturedAuthHeader: string | undefined;

		const server = createServer((req, res) => {
			capturedAuthHeader = req.headers.authorization;
			if (req.url === "/models" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "custom-test-model",
								metadata: { context_limit: 500000, output_budget: 16000 },
								enabled: true,
							},
						],
					}),
				);
				return;
			}
			res.writeHead(404).end();
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		const localBaseUrl = `http://127.0.0.1:${port}`;

		try {
			const context = createMockRefreshContext({
				allowNetwork: true,
				credential: { type: "api_key", key: "test-credential-token" },
			});

			const models = await refreshOpenDesignModels(context, localBaseUrl);
			assert.equal(capturedAuthHeader, "Bearer test-credential-token");
			assert.equal(models.length, 1);
			assert.equal(models[0]?.id, "custom-test-model");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	test("refreshModels falls back to default models on HTTP error", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(500).end("Internal Server Error");
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		const localBaseUrl = `http://127.0.0.1:${port}`;

		try {
			const context = createMockRefreshContext({
				allowNetwork: true,
				credential: { type: "api_key", key: "some-key" },
			});

			const models = await refreshOpenDesignModels(context, localBaseUrl);
			assert.deepEqual(models, DEFAULT_MODELS);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
