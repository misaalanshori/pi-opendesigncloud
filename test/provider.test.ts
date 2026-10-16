import assert from "node:assert/strict";
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
	test("creates valid ProviderConfig with default settings", () => {
		const config = createOpenDesignProviderConfig();

		assert.equal(config.name, OPENDESIGN_PROVIDER_NAME);
		assert.equal(config.baseUrl, OPENDESIGN_BASE_URL);
		assert.equal(config.apiKey, `$${OPENDESIGN_API_KEY_ENV}`);
		assert.equal(config.api, "openai-completions");
		assert.ok(Array.isArray(config.models));
		assert.equal(config.models.length, DEFAULT_MODELS.length);
		assert.equal(typeof config.refreshModels, "function");
	});

	test("creates ProviderConfig with custom baseUrl", () => {
		const customBaseUrl = "https://custom-proxy.internal/v1";
		const config = createOpenDesignProviderConfig(customBaseUrl);
		assert.equal(config.baseUrl, customBaseUrl);
	});

	test("registers provider with ExtensionAPI on extension initialization", () => {
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

	test("refreshModels returns default models when allowNetwork is false without fetching", async () => {
		let fetchCalled = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (): Promise<Response> => {
			fetchCalled = true;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;

		try {
			const context = createMockRefreshContext({ allowNetwork: false });
			const models = await refreshOpenDesignModels(context);
			assert.equal(fetchCalled, false, "Fetch should not be called when network is disallowed");
			assert.deepEqual(models, DEFAULT_MODELS);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("refreshModels returns default models when no api key or credential exists without fetching", async () => {
		let fetchCalled = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (): Promise<Response> => {
			fetchCalled = true;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;

		const prevEnv = process.env[OPENDESIGN_API_KEY_ENV];
		delete process.env[OPENDESIGN_API_KEY_ENV];

		try {
			const context = createMockRefreshContext({ allowNetwork: true, credential: undefined });
			const models = await refreshOpenDesignModels(context);
			assert.equal(fetchCalled, false, "Fetch should not be called when no credentials exist");
			assert.deepEqual(models, DEFAULT_MODELS);
		} finally {
			if (prevEnv !== undefined) process.env[OPENDESIGN_API_KEY_ENV] = prevEnv;
			globalThis.fetch = originalFetch;
		}
	});

	test("refreshModels fetches and parses models using credential token", async () => {
		let requestedUrl: string | undefined;
		let requestedAuth: string | undefined;
		let passedSignal: AbortSignal | null | undefined;

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		): Promise<Response> => {
			requestedUrl = input.toString();
			const headers = new Headers(init?.headers);
			requestedAuth = headers.get("Authorization") ?? undefined;
			passedSignal = init?.signal;
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "mock-model-1",
							architecture: { input_modalities: ["text", "image"] },
							metadata: { context_limit: 500000, output_budget: 16000 },
							enabled: true,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		try {
			const abortController = new AbortController();
			const context = createMockRefreshContext({
				allowNetwork: true,
				signal: abortController.signal,
				credential: { type: "api_key", key: "mock-stored-secret" },
			});

			const models = await refreshOpenDesignModels(context, "https://api.test/v1");

			assert.equal(requestedUrl, "https://api.test/v1/models");
			assert.equal(requestedAuth, "Bearer mock-stored-secret");
			assert.equal(passedSignal, abortController.signal);
			assert.equal(models.length, 1);
			const firstModel = models[0];
			assert.ok(firstModel && "contextWindow" in firstModel && "maxTokens" in firstModel);
			assert.equal(firstModel.id, "mock-model-1");
			assert.equal(firstModel.name, "Mock Model 1");
			assert.equal(firstModel.contextWindow, 500000);
			assert.equal(firstModel.maxTokens, 16000);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("refreshModels falls back to environment variable when credential is not passed", async () => {
		let requestedAuth: string | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		): Promise<Response> => {
			const headers = new Headers(init?.headers);
			requestedAuth = headers.get("Authorization") ?? undefined;
			return new Response(JSON.stringify({ object: "list", data: [{ id: "env-model", enabled: true }] }), {
				status: 200,
			});
		}) as typeof fetch;

		const prevEnv = process.env[OPENDESIGN_API_KEY_ENV];
		process.env[OPENDESIGN_API_KEY_ENV] = "env-secret-token";

		try {
			const context = createMockRefreshContext({ allowNetwork: true, credential: undefined });
			const models = await refreshOpenDesignModels(context);

			assert.equal(requestedAuth, "Bearer env-secret-token");
			assert.equal(models.length, 1);
			assert.equal(models[0]?.id, "env-model");
		} finally {
			if (prevEnv !== undefined) process.env[OPENDESIGN_API_KEY_ENV] = prevEnv;
			else delete process.env[OPENDESIGN_API_KEY_ENV];
			globalThis.fetch = originalFetch;
		}
	});

	test("refreshModels falls back to default models when API returns HTTP error", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (): Promise<Response> => {
			return new Response("Unauthorized", { status: 401 });
		}) as typeof fetch;

		try {
			const context = createMockRefreshContext({
				allowNetwork: true,
				credential: { type: "api_key", key: "invalid-key" },
			});
			const models = await refreshOpenDesignModels(context);
			assert.deepEqual(models, DEFAULT_MODELS);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("refreshModels falls back to default models when fetch rejects with network error", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (): Promise<Response> => {
			throw new Error("DNS resolution failure");
		}) as typeof fetch;

		try {
			const context = createMockRefreshContext({
				allowNetwork: true,
				credential: { type: "api_key", key: "valid-key" },
			});
			const models = await refreshOpenDesignModels(context);
			assert.deepEqual(models, DEFAULT_MODELS);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("refreshModels falls back to default models when API returns empty model array", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (): Promise<Response> => {
			return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
		}) as typeof fetch;

		try {
			const context = createMockRefreshContext({
				allowNetwork: true,
				credential: { type: "api_key", key: "valid-key" },
			});
			const models = await refreshOpenDesignModels(context);
			assert.deepEqual(models, DEFAULT_MODELS);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
