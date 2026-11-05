import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	RefreshModelsContext,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import extensionFactory, {
	createOpenDesignProviderConfig,
	isOpenDesignRetryableError,
	refreshOpenDesignModels,
	sanitizeOpenDesignErrorMessage,
	streamOpenDesign,
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

	test("refreshModels retries on transient 503 and returns models on recovery", async () => {
		let callCount = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (): Promise<Response> => {
			callCount++;
			if (callCount === 1) {
				return new Response(
					JSON.stringify({
						code: "database_unavailable",
						message: "[code=database_unavailable] resolve Billing Scope: status 503: database_unavailable",
					}),
					{ status: 503 },
				);
			}
			return new Response(
				JSON.stringify({
					object: "list",
					data: [{ id: "recovered-model", enabled: true }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		try {
			const context = createMockRefreshContext({
				allowNetwork: true,
				credential: { type: "api_key", key: "valid-key" },
			});
			const models = await refreshOpenDesignModels(context, OPENDESIGN_BASE_URL, {
				maxRetries: 2,
				baseDelayMs: 1,
			});
			assert.equal(callCount, 2);
			assert.equal(models.length, 1);
			assert.equal(models[0]?.id, "recovered-model");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("isOpenDesignRetryableError correctly classifies retryable vs non-retryable errors", () => {
		assert.equal(
			isOpenDesignRetryableError(
				'Error: 503: {"code":"database_unavailable","message":"[code=database_unavailable] resolve Billing Scope: status 503: database_unavailable","type":"database_unavailable"}',
			),
			true,
		);
		assert.equal(isOpenDesignRetryableError("502 Bad Gateway"), true);
		assert.equal(isOpenDesignRetryableError("500 Internal Server Error"), true);
		assert.equal(isOpenDesignRetryableError("429 Too Many Requests"), true);
		assert.equal(isOpenDesignRetryableError("TypeError: fetch failed"), true);
		assert.equal(isOpenDesignRetryableError("read ECONNRESET"), true);
		assert.equal(isOpenDesignRetryableError("stream ended without finish_reason"), true);

		assert.equal(isOpenDesignRetryableError("Error: 401 Unauthorized"), false);
		assert.equal(isOpenDesignRetryableError("Error: 404 Not Found"), false);
		assert.equal(isOpenDesignRetryableError("Error: 400 Bad Request"), false);
		assert.equal(isOpenDesignRetryableError(undefined), false);
	});

	test("sanitizeOpenDesignErrorMessage allows Pi's agent-level classifier to retry 503 billing errors", () => {
		const raw503 =
			'Error: 503: {"code":"database_unavailable","message":"[code=database_unavailable] resolve Billing Scope: status 503: database_unavailable","type":"database_unavailable"}';

		// Pi built-in classifier rejects the raw error because of the word "Billing"
		const rawAssistantMsg: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: OPENDESIGN_PROVIDER_ID,
			model: "deepseek-v4.1-flash",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: raw503,
			timestamp: Date.now(),
		};
		assert.equal(isRetryableAssistantError(rawAssistantMsg), false);

		// After sanitization, "Billing Scope" is rewritten and Pi classifies 503 as retryable
		const sanitizedMessage = sanitizeOpenDesignErrorMessage(raw503);
		assert.ok(!sanitizedMessage.toLowerCase().includes("billing"));
		const sanitizedAssistantMsg: AssistantMessage = {
			...rawAssistantMsg,
			errorMessage: sanitizedMessage,
		};
		assert.equal(isRetryableAssistantError(sanitizedAssistantMsg), true);
	});

	test("streamOpenDesign transparently retries on transient 503 and delivers completion", async () => {
		let attempts = 0;
		const mockModel: Model<"openai-completions"> = {
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			provider: OPENDESIGN_PROVIDER_ID,
			baseUrl: OPENDESIGN_BASE_URL,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: true,
			contextWindow: 1048000,
			maxTokens: 32000,
		};
		const mockContext: TranscriptContext = {
			messages: [],
		} as unknown as TranscriptContext;

		const mockStreamFn = () => {
			attempts++;
			const inner = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (attempts === 1) {
					inner.push({
						type: "error",
						reason: "error",
						error: {
							role: "assistant",
							content: [],
							api: "openai-completions",
							provider: OPENDESIGN_PROVIDER_ID,
							model: mockModel.id,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "error",
							errorMessage:
								'Error: 503: {"code":"database_unavailable","message":"[code=database_unavailable] resolve Billing Scope: status 503: database_unavailable","type":"database_unavailable"}',
							timestamp: Date.now(),
						},
					});
					inner.end();
				} else {
					const msg: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "Hello from OpenDesign!" }],
						api: "openai-completions",
						provider: OPENDESIGN_PROVIDER_ID,
						model: mockModel.id,
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 15,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					inner.push({ type: "start", partial: msg });
					inner.push({ type: "text_start", contentIndex: 0, partial: msg });
					inner.push({ type: "text_delta", contentIndex: 0, delta: "Hello from OpenDesign!", partial: msg });
					inner.push({ type: "text_end", contentIndex: 0, content: "Hello from OpenDesign!", partial: msg });
					inner.push({ type: "done", reason: "stop", message: msg });
					inner.end();
				}
			});
			return inner;
		};

		const stream = streamOpenDesign(
			mockModel,
			mockContext,
			undefined,
			mockStreamFn,
			{ maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 },
		);

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		assert.equal(attempts, 2);
		const startEvents = events.filter((e) => e.type === "start");
		assert.equal(startEvents.length, 1, "Only one start event should be emitted to consumer");
		const doneEvent = events.find((e) => e.type === "done");
		assert.ok(doneEvent);
	});

	test("streamOpenDesign exhausts retries and emits sanitized error", async () => {
		let attempts = 0;
		const mockModel: Model<"openai-completions"> = {
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			provider: OPENDESIGN_PROVIDER_ID,
			baseUrl: OPENDESIGN_BASE_URL,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: true,
			contextWindow: 1048000,
			maxTokens: 32000,
		};
		const mockContext: TranscriptContext = {
			messages: [],
		} as unknown as TranscriptContext;

		const mockStreamFn = () => {
			attempts++;
			const inner = createAssistantMessageEventStream();
			queueMicrotask(() => {
				inner.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						api: "openai-completions",
						provider: OPENDESIGN_PROVIDER_ID,
						model: mockModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage:
							'Error: 503: {"code":"database_unavailable","message":"[code=database_unavailable] resolve Billing Scope: status 503: database_unavailable","type":"database_unavailable"}',
						timestamp: Date.now(),
					},
				});
				inner.end();
			});
			return inner;
		};

		const stream = streamOpenDesign(
			mockModel,
			mockContext,
			undefined,
			mockStreamFn,
			{ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 },
		);

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		assert.equal(attempts, 3); // initial attempt + 2 retries
		assert.equal(events.length, 1);
		const errEvent = events[0];
		assert.ok(errEvent && errEvent.type === "error");
		assert.ok(errEvent.error.errorMessage);
		assert.ok(!errEvent.error.errorMessage.toLowerCase().includes("billing"));
		assert.ok(isRetryableAssistantError(errEvent.error));
	});

	test("streamOpenDesign does not retry non-retryable 401 error", async () => {
		let attempts = 0;
		const mockModel: Model<"openai-completions"> = {
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			provider: OPENDESIGN_PROVIDER_ID,
			baseUrl: OPENDESIGN_BASE_URL,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: true,
			contextWindow: 1048000,
			maxTokens: 32000,
		};
		const mockContext: TranscriptContext = {
			messages: [],
		} as unknown as TranscriptContext;

		const mockStreamFn = () => {
			attempts++;
			const inner = createAssistantMessageEventStream();
			queueMicrotask(() => {
				inner.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						api: "openai-completions",
						provider: OPENDESIGN_PROVIDER_ID,
						model: mockModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: "Error: 401 Invalid API Key",
						timestamp: Date.now(),
					},
				});
				inner.end();
			});
			return inner;
		};

		const stream = streamOpenDesign(
			mockModel,
			mockContext,
			undefined,
			mockStreamFn,
			{ maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 },
		);

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		assert.equal(attempts, 1, "Should not retry 401 error");
		assert.equal(events.length, 1);
		assert.equal(events[0]?.type, "error");
	});

	test("streamOpenDesign aborts immediately when signal is aborted", async () => {
		const abortController = new AbortController();
		abortController.abort();

		const mockModel: Model<"openai-completions"> = {
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			provider: OPENDESIGN_PROVIDER_ID,
			baseUrl: OPENDESIGN_BASE_URL,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: true,
			contextWindow: 1048000,
			maxTokens: 32000,
		};
		const mockContext: TranscriptContext = {
			messages: [],
		} as unknown as TranscriptContext;

		let attempts = 0;
		const mockStreamFn = () => {
			attempts++;
			return createAssistantMessageEventStream();
		};

		const stream = streamOpenDesign(
			mockModel,
			mockContext,
			{ signal: abortController.signal },
			mockStreamFn,
		);

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		assert.equal(attempts, 0);
		assert.equal(events.length, 1);
		assert.equal(events[0]?.type, "error");
		assert.equal(events[0]?.reason, "aborted");
	});
});
