import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MODELS,
	OPENDESIGN_API_KEY_ENV,
	OPENDESIGN_BASE_URL,
	OPENDESIGN_PROVIDER_ID,
	OPENDESIGN_PROVIDER_NAME,
	parseOpenDesignModels,
} from "./models.ts";

export async function refreshOpenDesignModels(
	context: RefreshModelsContext,
	baseUrl: string = OPENDESIGN_BASE_URL,
): Promise<ProviderModelConfig[]> {
	if (!context.allowNetwork) return DEFAULT_MODELS;

	const apiKey =
		context.credential?.type === "api_key" && context.credential.key
			? context.credential.key
			: process.env[OPENDESIGN_API_KEY_ENV];

	if (!apiKey) return DEFAULT_MODELS;

	try {
		const res = await fetch(`${baseUrl}/models`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			signal: context.signal,
		});

		if (!res.ok) return DEFAULT_MODELS;

		const json: unknown = await res.json();
		const models = parseOpenDesignModels(json);
		return models.length > 0 ? models : DEFAULT_MODELS;
	} catch {
		return DEFAULT_MODELS;
	}
}

export function createOpenDesignProviderConfig(baseUrl: string = OPENDESIGN_BASE_URL): ProviderConfig {
	return {
		name: OPENDESIGN_PROVIDER_NAME,
		baseUrl,
		apiKey: `$${OPENDESIGN_API_KEY_ENV}`,
		api: "openai-completions",
		models: DEFAULT_MODELS,
		refreshModels: (context) => refreshOpenDesignModels(context, baseUrl),
	};
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(OPENDESIGN_PROVIDER_ID, createOpenDesignProviderConfig());
}
