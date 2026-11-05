import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	RefreshModelsContext,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MODELS,
	OPENDESIGN_API_KEY_ENV,
	OPENDESIGN_BASE_URL,
	OPENDESIGN_PROVIDER_ID,
	OPENDESIGN_PROVIDER_NAME,
	parseOpenDesignModels,
} from "./models.ts";

export const DEFAULT_STREAM_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 8000;

export interface OpenDesignRetryOptions {
	maxRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
}

export type StreamSimpleFn = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		const error = new Error("Aborted");
		error.name = "AbortError";
		return Promise.reject(error);
	}
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			const error = new Error("Aborted");
			error.name = "AbortError";
			reject(error);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function computeRetryDelay(
	attempt: number,
	maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
	baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
	errorMessage?: string,
): number {
	if (errorMessage) {
		const match = errorMessage.match(/retry[- ]?(?:after|delay)?:?\s*(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms)?/i);
		if (match) {
			const val = Number.parseFloat(match[1]);
			if (Number.isFinite(val)) {
				const ms = match[2]?.toLowerCase() === "ms" ? val : val * 1000;
				return Math.min(ms, maxDelayMs);
			}
		}
	}
	const base = baseDelayMs * 2 ** attempt;
	const jitter = base * (0.8 + Math.random() * 0.4);
	return Math.min(jitter, maxDelayMs);
}

export function isOpenDesignRetryableError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	if (/\b(500|502|503|504|520|521|522|524|529|429|408)\b/.test(errorMessage)) return true;
	if (/database_unavailable|server_busy|overloaded/i.test(errorMessage)) return true;
	if (
		/fetch failed|network.?error|connection.?error|connection.?lost|connection.?reset|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(
			errorMessage,
		)
	) {
		return true;
	}
	if (/service.?(?:is.?)?(?:temporarily.?)?unavailable/i.test(errorMessage)) return true;
	if (/stream ended without finish_reason|ended without/i.test(errorMessage)) return true;
	return false;
}

export function sanitizeOpenDesignErrorMessage(message: string): string {
	// OpenDesign transient 503 errors include "[code=database_unavailable] resolve Billing Scope: status 503: database_unavailable".
	// The word "billing" triggers Pi's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN, treating transient 503 outages
	// as non-retryable account quota exhaustion. We rewrite "Billing Scope" so Pi recognizes the 503 status.
	if (/\b(500|502|503|504|520|524|database_unavailable)\b/i.test(message)) {
		return message.replace(/billing([-_ ]?(scope|db|database|service))?/gi, "service scope");
	}
	return message.replace(/billing[-_ ]?scope/gi, "service scope");
}

function createAssistantError(
	model: Model<string>,
	stopReason: "error" | "aborted",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

export function streamOpenDesign(
	model: Model<string>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	streamFn?: StreamSimpleFn,
	retryConfig?: OpenDesignRetryOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const effectiveStreamFn =
		streamFn ??
		((m, c, o) => openAICompletionsApi().streamSimple(m, c, o));

	const maxRetries =
		retryConfig?.maxRetries ??
		(typeof options?.maxRetries === "number" && options.maxRetries > 0
			? options.maxRetries
			: DEFAULT_STREAM_MAX_RETRIES);
	const baseDelayMs = retryConfig?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs = options?.maxRetryDelayMs ?? retryConfig?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

	(async () => {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (options?.signal?.aborted) {
				stream.push({
					type: "error",
					reason: "aborted",
					error: createAssistantError(model, "aborted"),
				});
				stream.end();
				return;
			}

			let hasEmittedContent = false;
			let bufferedStart: AssistantMessageEvent | undefined;

			try {
				const innerStream = effectiveStreamFn(
					model as Model<"openai-completions">,
					context,
					options,
				);

				let shouldRetry = false;
				let lastErrorEvent: Extract<AssistantMessageEvent, { type: "error" }> | undefined;

				for await (const event of innerStream) {
					if (options?.signal?.aborted) {
						stream.push({
							type: "error",
							reason: "aborted",
							error: createAssistantError(model, "aborted"),
						});
						stream.end();
						return;
					}

					if (event.type === "error") {
						const errMessage = event.error.errorMessage;
						if (!hasEmittedContent && attempt < maxRetries && isOpenDesignRetryableError(errMessage)) {
							shouldRetry = true;
							break;
						}
						lastErrorEvent = event;
						break;
					}

					if (event.type === "start") {
						bufferedStart = event;
						continue;
					}

					if (bufferedStart) {
						stream.push(bufferedStart);
						bufferedStart = undefined;
					}

					hasEmittedContent = true;
					stream.push(event);
				}

				if (shouldRetry) {
					const delay = computeRetryDelay(attempt, maxDelayMs, baseDelayMs);
					try {
						await abortableSleep(delay, options?.signal);
					} catch {
						stream.push({
							type: "error",
							reason: "aborted",
							error: createAssistantError(model, "aborted"),
						});
						stream.end();
						return;
					}
					continue;
				}

				if (lastErrorEvent) {
					if (lastErrorEvent.error.errorMessage) {
						lastErrorEvent.error.errorMessage = sanitizeOpenDesignErrorMessage(
							lastErrorEvent.error.errorMessage,
						);
					}
					stream.push(lastErrorEvent);
					stream.end();
					return;
				}

				if (bufferedStart) {
					stream.push(bufferedStart);
					bufferedStart = undefined;
				}
				stream.end();
				return;
			} catch (error) {
				if (options?.signal?.aborted) {
					stream.push({
						type: "error",
						reason: "aborted",
						error: createAssistantError(model, "aborted"),
					});
					stream.end();
					return;
				}
				const errMsg = error instanceof Error ? error.message : String(error);
				if (!hasEmittedContent && attempt < maxRetries && isOpenDesignRetryableError(errMsg)) {
					const delay = computeRetryDelay(attempt, maxDelayMs, baseDelayMs, errMsg);
					try {
						await abortableSleep(delay, options?.signal);
					} catch {
						stream.push({
							type: "error",
							reason: "aborted",
							error: createAssistantError(model, "aborted"),
						});
						stream.end();
						return;
					}
					continue;
				}

				stream.push({
					type: "error",
					reason: "error",
					error: createAssistantError(model, "error", sanitizeOpenDesignErrorMessage(errMsg)),
				});
				stream.end();
				return;
			}
		}
	})().catch((err: unknown) => {
		const errMsg = err instanceof Error ? err.message : String(err);
		stream.push({
			type: "error",
			reason: "error",
			error: createAssistantError(model, "error", sanitizeOpenDesignErrorMessage(errMsg)),
		});
		stream.end();
	});

	return stream;
}

export async function refreshOpenDesignModels(
	context: RefreshModelsContext,
	baseUrl: string = OPENDESIGN_BASE_URL,
	retryOptions?: { maxRetries?: number; baseDelayMs?: number },
): Promise<ProviderModelConfig[]> {
	if (!context.allowNetwork) return DEFAULT_MODELS;

	const apiKey =
		context.credential?.type === "api_key" && context.credential.key
			? context.credential.key
			: process.env[OPENDESIGN_API_KEY_ENV];

	if (!apiKey) return DEFAULT_MODELS;

	const maxRetries = retryOptions?.maxRetries ?? 2;
	const baseDelayMs = retryOptions?.baseDelayMs ?? 100;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (context.signal?.aborted) return DEFAULT_MODELS;

		try {
			const res = await fetch(`${baseUrl}/models`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
				signal: context.signal,
			});

			if (res.ok) {
				const json: unknown = await res.json();
				const models = parseOpenDesignModels(json);
				return models.length > 0 ? models : DEFAULT_MODELS;
			}

			if (res.status >= 500 || res.status === 429 || res.status === 408) {
				if (attempt < maxRetries && !context.signal?.aborted) {
					try {
						await abortableSleep(computeRetryDelay(attempt, 4000, baseDelayMs), context.signal);
						continue;
					} catch {
						return DEFAULT_MODELS;
					}
				}
			}

			return DEFAULT_MODELS;
		} catch {
			if (context.signal?.aborted) return DEFAULT_MODELS;
			if (attempt < maxRetries) {
				try {
					await abortableSleep(computeRetryDelay(attempt, 4000, baseDelayMs), context.signal);
					continue;
				} catch {
					return DEFAULT_MODELS;
				}
			}
			return DEFAULT_MODELS;
		}
	}

	return DEFAULT_MODELS;
}

export function createOpenDesignProviderConfig(
	baseUrl: string = OPENDESIGN_BASE_URL,
	customStreamSimple?: StreamSimpleFn,
): ProviderConfig {
	return {
		name: OPENDESIGN_PROVIDER_NAME,
		baseUrl,
		apiKey: `$${OPENDESIGN_API_KEY_ENV}`,
		api: "openai-completions",
		models: DEFAULT_MODELS,
		refreshModels: (context) => refreshOpenDesignModels(context, baseUrl),
		streamSimple: (model, context, options) =>
			streamOpenDesign(model, context, options, customStreamSimple),
	};
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(OPENDESIGN_PROVIDER_ID, createOpenDesignProviderConfig());
}
