import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type OpenDesignModelConfig = Extract<ProviderModelConfig, { maxTokens: number }>;

export const OPENDESIGN_BASE_URL = "https://amr-link.open-design.ai/v1";
export const OPENDESIGN_PROVIDER_ID = "opendesign";
export const OPENDESIGN_PROVIDER_NAME = "OpenDesign";
export const OPENDESIGN_API_KEY_ENV = "OPENDESIGN_API_KEY";

export interface OpenDesignApiModel {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	metadata?: {
		cost?: string;
		capability?: string;
		context_limit?: number;
		context_budget?: number;
		output_budget?: number;
	};
	default?: boolean;
	enabled?: boolean;
}

const ACRONYMS: Record<string, string> = {
	glm: "GLM",
	gpt: "GPT",
};

export function formatModelDisplayName(id: string): string {
	return id
		.split("-")
		.map((part) => {
			const lower = part.toLowerCase();
			const acronym = ACRONYMS[lower];
			if (acronym) return acronym;
			if (lower === "deepseek") return "DeepSeek";
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
}

function parseInputModalities(modalities: unknown): ("text" | "image")[] {
	if (!Array.isArray(modalities)) return ["text"];
	const hasImage = modalities.some((m) => m === "image");
	return hasImage ? ["text", "image"] : ["text"];
}

export function parseOpenDesignModels(json: unknown): OpenDesignModelConfig[] {
	if (!json || typeof json !== "object") return [];
	const obj = json as Record<string, unknown>;
	if (!Array.isArray(obj.data)) return [];

	const result: OpenDesignModelConfig[] = [];
	for (const raw of obj.data) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, unknown>;
		if (typeof item.id !== "string" || !item.id) continue;
		if (item.enabled === false) continue;

		const arch = typeof item.architecture === "object" && item.architecture !== null
			? (item.architecture as Record<string, unknown>)
			: undefined;
		const meta = typeof item.metadata === "object" && item.metadata !== null
			? (item.metadata as Record<string, unknown>)
			: undefined;

		const contextLimit = typeof meta?.context_limit === "number" && meta.context_limit > 0
			? meta.context_limit
			: 128000;
		const outputBudget = typeof meta?.output_budget === "number" && meta.output_budget > 0
			? meta.output_budget
			: 32000;

		result.push({
			id: item.id,
			name: formatModelDisplayName(item.id),
			input: parseInputModalities(arch?.input_modalities),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: true,
			contextWindow: contextLimit,
			maxTokens: outputBudget,
		});
	}

	return result;
}

export const DEFAULT_MODELS: OpenDesignModelConfig[] = [
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1048000,
		maxTokens: 32000,
	},
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1048000,
		maxTokens: 32000,
	},
	{
		id: "deepseek-v4-flash-vision-exp",
		name: "DeepSeek V4 Flash Vision Exp",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1048000,
		maxTokens: 32000,
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1048000,
		maxTokens: 32000,
	},
	{
		id: "claude-haiku-5.5",
		name: "Claude Haiku 5.5",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1000000,
		maxTokens: 32000,
	},
	{
		id: "glm-5.3-flash",
		name: "GLM 5.3 Flash",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1048000,
		maxTokens: 32000,
	},
	{
		id: "glm-5.3-flashx",
		name: "GLM 5.3 Flashx",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1000000,
		maxTokens: 32000,
	},
	{
		id: "gpt-6-luna",
		name: "GPT 6 Luna",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1050000,
		maxTokens: 32000,
	},
	{
		id: "kimi-k2.7-code",
		name: "Kimi K2.7 Code",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 262000,
		maxTokens: 32000,
	},
	{
		id: "mimo-v2.6-flash",
		name: "Mimo V2.6 Flash",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1048000,
		maxTokens: 32000,
	},
	{
		id: "mimo-v2.6-pro",
		name: "Mimo V2.6 Pro",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1048000,
		maxTokens: 32000,
	},
];
