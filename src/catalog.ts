// Works out which models a provider offers, using its own model API plus models.dev.

import { fixerBaseUrl, needsToolFix } from "./fixer";
import type { DroidProvider, Provider } from "./providers";
import { helperCommand } from "./self";
import type { ModelHealth, Settings } from "./store";

// Image, video, speech, embedding and similar models can't run a coding session.
const NON_CHAT_NAMES = /:batch|embed|rerank|whisper|(^|[-_/.])tts($|[-_/.])|speech|transcri|dall-?e|(^|[-_/.])image($|[-_/.])|imagen|imagine|sora|(^|[-_/.])video($|[-_/.])|(^|[-_/.])veo|flux|stable-?diffusion|sdxl|moderation|safeguard|(^|[-_/.])ocr($|[-_/.])|(^|[-_/.])audio($|[-_/.])|music|realtime|-[itr]2v/i;

// A last resort for models no source describes, such as glm-5v-turbo or qwen-vl.
const VISION_NAMES = /vision|(^|[-_/.])vl($|[-_/.])|\d(\.\d+)?v($|[-_])/i;

export interface Model {
	id: string;
	name: string;
	context?: number;
	output?: number;
	outputPrice?: number;
	tools?: boolean;
	reasoning?: boolean;
	efforts?: string[];
	image?: boolean;
	// What the data says, before any check on this host. A check only tests images if this is true.
	advertisedImage?: boolean;
	textOutput?: boolean;
	released: string;
	deprecated: boolean;
	droidProvider?: DroidProvider;
	baseUrl?: string;
}

// biome-ignore lint: provider and models.dev payloads are untyped JSON.
type Json = any;
export type Entry = Record<string, Json>;

const API_PROTOCOLS: Record<string, DroidProvider> = {
	"chat-completions": "generic-chat-completion-api",
	messages: "anthropic",
	responses: "openai",
};

const NPM_PROTOCOLS: Record<string, DroidProvider> = {
	"@ai-sdk/openai-compatible": "generic-chat-completion-api",
	"@openrouter/ai-sdk-provider": "generic-chat-completion-api",
	"@ai-sdk/anthropic": "anthropic",
	"@ai-sdk/openai": "openai",
};

// Droid appends /v1/messages to anthropic base URLs.
const droidBaseUrl = (provider: DroidProvider, url?: string) =>
	provider === "anthropic" ? url?.replace(/\/v1\/?$/, "") : url;

function resolveProtocol(provider: Provider, live: Json, md: Json, mdProvider: Json) {
	if (provider.droidProvider) return { droidProvider: provider.droidProvider, baseUrl: provider.baseUrl };
	const kind = Object.keys(live?.api ?? {})[0];
	if (kind) {
		const protocol = API_PROTOCOLS[kind];
		return protocol ? { droidProvider: protocol, baseUrl: droidBaseUrl(protocol, live.api[kind].base_url) } : {};
	}
	const protocol = NPM_PROTOCOLS[md?.provider?.npm ?? mdProvider?.npm];
	return protocol ? { droidProvider: protocol, baseUrl: droidBaseUrl(protocol, md?.provider?.api ?? mdProvider?.api) } : {};
}

// What a model can do doesn't depend on who hosts it, unlike its price or limits.
export interface Capabilities {
	image?: boolean;
	tools?: boolean;
	textOutput?: boolean;
}

export const normalizeModelName = (id: string) =>
	(id.split("/").pop() ?? id).split(":")[0]?.toLowerCase().replace(/_/g, "-").replace(/-(fp8|fp4|bf16|int8|gguf)$/, "") ?? id;

const capabilityIndexes = new WeakMap<object, Map<string, Capabilities>>();

// Looks up each model across every provider on models.dev. OpenRouter tracks upstream closely, so it
// wins; otherwise the majority decides, because one host listing images is not proof the model takes them.
export function capabilityIndex(modelsDev: Json): Map<string, Capabilities> {
	if (!modelsDev) return new Map();
	const cached = capabilityIndexes.get(modelsDev);
	if (cached) return cached;
	const votes = new Map<string, { image: number; noImage: number; tools?: boolean; textOutput?: boolean; preferred?: Capabilities }>();
	for (const [providerKey, provider] of Object.entries<Json>(modelsDev)) {
		for (const [id, model] of Object.entries<Json>(provider?.models ?? {})) {
			const input: string[] | undefined = model?.modalities?.input;
			if (!input) continue;
			const name = normalizeModelName(id);
			const vote = votes.get(name) ?? { image: 0, noImage: 0 };
			vote[input.includes("image") ? "image" : "noImage"]++;
			vote.tools ??= model.tool_call;
			vote.textOutput ??= model.modalities?.output?.includes("text");
			if (providerKey === "openrouter") vote.preferred = { image: input.includes("image"), tools: model.tool_call, textOutput: model.modalities?.output?.includes("text") };
			votes.set(name, vote);
		}
	}
	const index = new Map<string, Capabilities>();
	for (const [name, vote] of votes) {
		index.set(name, vote.preferred ?? { image: vote.image > vote.noImage, tools: vote.tools, textOutput: vote.textOutput });
	}
	capabilityIndexes.set(modelsDev, index);
	return index;
}

// models.dev is preferred; a provider's own fields cover models it hasn't listed yet.
export function describeModel(id: string, live: Json, md: Json, provider: Provider, mdProvider: Json, known?: Capabilities): Model {
	const perToken = Number(live?.pricing?.completion);
	const inputs: string[] | undefined = md?.modalities?.input ?? live?.modalities?.input ?? live?.architecture?.input_modalities;
	const outputs: string[] | undefined = md?.modalities?.output ?? live?.modalities?.output ?? live?.architecture?.output_modalities;
	const image = inputs?.includes("image") ?? known?.image ?? (VISION_NAMES.test(id) ? true : undefined);
	return {
		id,
		name: md?.name ?? live?.name ?? id,
		context: md?.limit?.context ?? live?.limit?.context ?? live?.context_length,
		output: md?.limit?.output ?? live?.limit?.output ?? live?.top_provider?.max_completion_tokens,
		outputPrice: md?.cost?.output ?? live?.cost?.text?.output?.price ?? (Number.isFinite(perToken) ? perToken * 1e6 : undefined),
		tools: md?.tool_call ?? live?.capabilities?.tools?.supported ?? live?.supported_parameters?.includes("tools") ?? known?.tools,
		reasoning: md?.reasoning ?? live?.capabilities?.reasoning?.supported ?? live?.supported_parameters?.includes("reasoning"),
		efforts: md?.reasoning_options?.find((o: Json) => o.type === "effort")?.values ?? live?.capabilities?.reasoning?.effort,
		image,
		advertisedImage: image,
		textOutput: outputs?.includes("text") ?? known?.textOutput,
		released: md?.release_date ?? live?.release_date ?? (live?.created ? new Date(live.created * 1000).toISOString().slice(0, 10) : ""),
		deprecated: md?.status === "deprecated" || md?.status === "alpha",
		...resolveProtocol(provider, live, md, mdProvider),
	};
}

export const isChatModel = (m: Model) => m.textOutput !== false && !NON_CHAT_NAMES.test(m.id);

export function chooseModels(available: Model[], provider: Provider, settings: Settings): Model[] {
	const selected = new Set(settings.selected[provider.id] ?? []);
	return available.filter(m => selected.has(m.id));
}

export function toggleModel(settings: Settings, provider: Provider, modelId: string): Settings {
	const selected = new Set(settings.selected[provider.id] ?? []);
	if (!selected.delete(modelId)) selected.add(modelId);
	return { ...settings, selected: { ...settings.selected, [provider.id]: [...selected] } };
}

export function toEntry(m: Model, provider: Provider, settings: Settings): Entry {
	const effort = settings.reasoningEffort;
	const useEffort = effort && m.reasoning && (!m.efforts || m.efforts.includes(effort));
	const fixed = needsToolFix(provider, m.id);
	return {
		model: m.id,
		displayName: `${m.name} [${provider.label}]`,
		provider: m.droidProvider,
		baseUrl: fixed ? fixerBaseUrl(provider.id) : m.baseUrl,
		apiKeyHelper: helperCommand(provider.id, fixed),
		// A short interval means a stopped fixer is restarted within a minute of the next request.
		...(fixed ? { apiKeyHelperTtlMs: 60_000 } : {}),
		...(m.context ? { maxContextLimit: m.context } : {}),
		maxOutputTokens: Math.min(m.output ?? settings.maxOutputTokens, settings.maxOutputTokens),
		...(useEffort ? { reasoningEffort: effort } : {}),
		noImageSupport: !m.image,
	};
}

async function request(url: string, key?: string): Promise<Response | null> {
	try {
		const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "droid-models" };
		if (key) headers.Authorization = `Bearer ${key}`;
		let current = url;
		for (let hop = 0; hop < 4; hop++) {
			const response = await fetch(current, { headers, redirect: "manual", signal: AbortSignal.timeout(25_000) });
			const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
			if (!location) return response;
			const next = new URL(location, current);
			// A key must never follow a redirect to a different host, so that counts as a failed request.
			if (next.origin !== new URL(current).origin) return response;
			await response.body?.cancel();
			current = next.href;
		}
		return null;
	} catch {
		return null;
	}
}

export async function fetchJson(url: string): Promise<Json | null> {
	const response = await request(url);
	return response?.ok ? response.json().catch(() => null) : null;
}

const isRejection = (response: Response | null) => response?.status === 401 || response?.status === 403;

export type KeyCheck = "accepted" | "unverified" | "rejected" | "subscription";

// Claude subscription logins may only be used by Anthropic's own apps.
const isClaudeSubscriptionToken = (key: string) => key.startsWith("sk-ant-oat");

export async function verifyKey(provider: Provider, key: string): Promise<KeyCheck> {
	if (isClaudeSubscriptionToken(key)) return "subscription";
	const url = provider.verifyUrl ?? provider.listUrl;
	if (!url) return "unverified";
	const withKey = await request(url, key);
	if (isRejection(withKey)) return "rejected";
	if (!withKey?.ok) return "unverified";
	// A public URL answers anyone, so a success there says nothing about the key.
	return isRejection(await request(url)) ? "accepted" : "unverified";
}

export interface Plan {
	provider: Provider;
	keyRejected: boolean;
	listed: number;
	listSource: "provider API" | "models.dev" | "nowhere";
	available: Model[];
	selected: Model[];
	// Ticked, but not on the provider's list right now. These stay as they are until the user unticks them.
	missing: string[];
	entries: Entry[];
}

export const usableModels = (available: Model[], health?: Record<string, ModelHealth>) => (health ? available.filter(m => health[m.id]?.status !== "failed") : available);

export function buildPlan(plan: Plan, settings: Settings, health?: Record<string, ModelHealth>): Plan {
	const available = plan.available.map(m => {
		const advertised = m.advertisedImage ?? m.image;
		return { ...m, advertisedImage: advertised, image: health?.[m.id]?.noImage ? false : advertised };
	});
	const selected = chooseModels(usableModels(available, health), plan.provider, settings);
	const listed = new Set(available.map(m => m.id));
	const missing = (settings.selected[plan.provider.id] ?? []).filter(id => !listed.has(id));
	return { ...plan, available, selected, missing, entries: selected.map(m => toEntry(m, plan.provider, settings)) };
}

export async function planProvider(provider: Provider, key: string | null, settings: Settings, modelsDev: Json, health?: Record<string, ModelHealth>): Promise<Plan> {
	const mdProvider = provider.modelsDevKey ? modelsDev?.[provider.modelsDevKey] : undefined;
	const mdModels: Json = mdProvider?.models ?? {};
	const response = provider.listUrl ? await request(provider.listUrl, key ?? undefined) : null;
	// A dead key must not fall through to the models.dev list, or we'd add models that can't work.
	if (key && isRejection(response)) {
		return { provider, keyRejected: true, listed: 0, listSource: "nowhere", available: [], selected: [], missing: settings.selected[provider.id] ?? [], entries: [] };
	}
	const live: Json[] | undefined = response?.ok ? await response.json().then(body => body?.data).catch(() => undefined) : undefined;
	const useLive = Boolean(live?.length);
	const index = capabilityIndex(modelsDev);
	const known = (id: string) => index.get(normalizeModelName(id));
	const described = useLive
		? (live as Json[]).map(row => describeModel(row.id, row, mdModels[row.id], provider, mdProvider, known(row.id)))
		: Object.keys(mdModels).map(id => describeModel(id, undefined, mdModels[id], provider, mdProvider, known(id)));
	const available = described
		// Droid can't work without tool calls, so those models aren't offered.
		.filter(m => m.droidProvider && m.baseUrl && !m.deprecated && m.tools !== false && isChatModel(m))
		.sort((a, b) => b.released.localeCompare(a.released) || a.id.localeCompare(b.id));
	const plan: Plan = {
		provider,
		keyRejected: false,
		listed: described.length,
		listSource: useLive ? "provider API" : described.length ? "models.dev" : "nowhere",
		available,
		selected: [],
		missing: [],
		entries: [],
	};
	return buildPlan(plan, settings, health);
}
