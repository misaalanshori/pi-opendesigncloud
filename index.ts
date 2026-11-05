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

export const DEFAULT_STREAM_MAX_RETRIES = 5;
export const DEFAULT_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_DELAY_MS = 20000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

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
	const expDelay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
	// Equal jitter: guaranteed half backoff + random half backoff
	const half = expDelay / 2;
	return half + Math.random() * half;
}

const RETRYABLE_STATUS_PATTERN = /\b(500|502|503|504|520|521|522|523|524|525|526|529|429|408)\b/;

const RETRYABLE_TEXT_PATTERNS = [
	"database_unavailable",
	"server_busy",
	"servers are currently busy",
	"currently experiencing high demand",
	"model is at capacity",
	"overloaded",
	"rate.?limit",
	"too many requests",
	"service.?(?:is.?)?(?:temporarily.?)?unavailable",
	"server.?error",
	"internal.?error",
	"bad.?gateway",
	"gateway.?timeout",
	"provider.?returned.?(?:an.?)?error",
	"unable to forward upstream",
	"upstream.?connect",
	"reset before headers",
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"connection.?reset",
	"other side closed",
	"fetch failed",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",
	"ended without",
	"stream ended before",
	"premature close",
	"econnreset",
	"etimedout",
	"enotfound",
	"econnrefused",
	"und_err",
];
const RETRYABLE_TEXT_REGEX = new RegExp(RETRYABLE_TEXT_PATTERNS.join("|"), "i");

export function isOpenDesignRetryableError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	// Deterministic client errors fail fast unless also carrying 5xx
	if (
		/\b(400|401|403|404)\b/.test(errorMessage) &&
		!/\b(500|502|503|504|520|521|522|523|524|525|526|529)\b/.test(errorMessage)
	) {
		return false;
	}
	if (RETRYABLE_STATUS_PATTERN.test(errorMessage)) return true;
	return RETRYABLE_TEXT_REGEX.test(errorMessage);
}

export function sanitizeOpenDesignErrorMessage(message: string): string {
	// OpenDesign transient 503 errors include "[code=database_unavailable] resolve Billing Scope: status 503: database_unavailable".
	// The word "billing" triggers Pi's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN, treating transient 503 outages
	// as non-retryable account quota exhaustion. We rewrite "Billing" on any 5xx/database errors so Pi recognizes the retryable status.
	if (/\b(500|502|503|504|520|521|522|523|524|525|526|529|database_unavailable)\b/i.test(message)) {
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
	const attemptOptions: SimpleStreamOptions = {
		timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
		...options,
	};

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
			let bufferedEvents: AssistantMessageEvent[] = [];

			try {
				const innerStream = effectiveStreamFn(
					model as Model<"openai-completions">,
					context,
					attemptOptions,
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
						for (const buf of bufferedEvents) stream.push(buf);
						bufferedEvents = [];
						lastErrorEvent = event;
						break;
					}

					if (event.type === "start" || event.type === "text_start" || event.type === "thinking_start") {
						if (!hasEmittedContent) {
							bufferedEvents.push(event);
						} else {
							stream.push(event);
						}
						continue;
					}

					if (event.type === "text_delta" || event.type === "thinking_delta") {
						if (event.delta.length === 0) continue;
						if (!hasEmittedContent) {
							for (const buf of bufferedEvents) stream.push(buf);
							bufferedEvents = [];
							hasEmittedContent = true;
						}
						stream.push(event);
						continue;
					}

					if (
						event.type === "toolcall_start" ||
						event.type === "toolcall_delta" ||
						event.type === "toolcall_end"
					) {
						if (!hasEmittedContent) {
							for (const buf of bufferedEvents) stream.push(buf);
							bufferedEvents = [];
							hasEmittedContent = true;
						}
						stream.push(event);
						continue;
					}

					if (event.type === "text_end" || event.type === "thinking_end") {
						if (hasEmittedContent) {
							stream.push(event);
						} else {
							bufferedEvents.push(event);
						}
						continue;
					}

					if (event.type === "done") {
						if (!hasEmittedContent) {
							for (const buf of bufferedEvents) stream.push(buf);
							bufferedEvents = [];
							hasEmittedContent = true;
						}
						stream.push(event);
						continue;
					}

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

				if (bufferedEvents.length > 0) {
					for (const buf of bufferedEvents) stream.push(buf);
					bufferedEvents = [];
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

	const maxRetries = retryOptions?.maxRetries ?? 3;
	const baseDelayMs = retryOptions?.baseDelayMs ?? 250;

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
