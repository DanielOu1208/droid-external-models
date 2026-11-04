export type DroidProvider = "anthropic" | "openai" | "generic-chat-completion-api";

export interface Provider {
	id: string;
	label: string;
	// Where to create a key.
	keyUrl?: string;
	// Environment variable names this key commonly lives under, used only by Import.
	envNames: string[];
	modelsDevKey?: string;
	// Omit to use the models.dev list only.
	listUrl?: string;
	// A URL that always needs a valid key, for providers whose model list is public.
	verifyUrl?: string;
	// Omit both to use the protocol the provider or models.dev reports for each model.
	droidProvider?: DroidProvider;
	baseUrl?: string;
	// Model ID prefixes that connect through the local fixer, because the service behind them
	// rejects parts of Droid's tool definitions. An empty string matches every model.
	fixToolSchemas?: string[];
	// Has run real requests with a real key.
	tested?: boolean;
}

const chat = (id: string, label: string, envName: string, baseUrl: string, keyUrl: string, more: Partial<Provider> = {}): Provider => ({
	id,
	label,
	keyUrl,
	envNames: [envName],
	modelsDevKey: id,
	listUrl: `${baseUrl}/models`,
	droidProvider: "generic-chat-completion-api",
	baseUrl,
	...more,
});

export const PROVIDERS: Provider[] = [
	{
		id: "zai",
		label: "z.ai",
		keyUrl: "https://z.ai/manage-apikey/apikey-list",
		envNames: ["ZAI_API_KEY"],
		modelsDevKey: "zai",
		listUrl: "https://api.z.ai/api/coding/paas/v4/models",
		droidProvider: "anthropic",
		baseUrl: "https://api.z.ai/api/anthropic",
		tested: true,
	},
	chat("openrouter", "OpenRouter", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1", "https://openrouter.ai/keys", {
		verifyUrl: "https://openrouter.ai/api/v1/key",
		tested: true,
	}),
	{
		id: "opencode-go",
		label: "OpenCode Go",
		keyUrl: "https://opencode.ai/auth",
		envNames: ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"],
		modelsDevKey: "opencode-go",
		listUrl: "https://opencode.ai/zen/go/v1/models",
	},
	chat("gmi-cloud", "GMI Cloud", "GMI_API_KEY", "https://api.gmi-serving.com/v1", "https://console.gmicloud.ai", {
		modelsDevKey: "gmicloud",
		fixToolSchemas: ["google/"],
		tested: true,
	}),
	{
		id: "anthropic",
		label: "Anthropic (API key)",
		keyUrl: "https://console.anthropic.com/settings/keys",
		envNames: ["ANTHROPIC_API_KEY"],
		modelsDevKey: "anthropic",
		droidProvider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		},
	chat("openai", "OpenAI (API key)", "OPENAI_API_KEY", "https://api.openai.com/v1", "https://platform.openai.com/api-keys", { droidProvider: "openai" }),
	// Google's OpenAI-compatible model list uses different IDs, so this one relies on models.dev.
	chat("google", "Google Gemini", "GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai", "https://aistudio.google.com/apikey", { listUrl: undefined, fixToolSchemas: [""] }),
	chat("deepseek", "DeepSeek", "DEEPSEEK_API_KEY", "https://api.deepseek.com", "https://platform.deepseek.com/api_keys"),
	chat("xai", "xAI", "XAI_API_KEY", "https://api.x.ai/v1", "https://console.x.ai/team/default/api-keys"),
	chat("mistral", "Mistral", "MISTRAL_API_KEY", "https://api.mistral.ai/v1", "https://console.mistral.ai/api-keys"),
	chat("moonshot", "Moonshot", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1", "https://platform.moonshot.ai/console/api-keys", { modelsDevKey: "moonshotai" }),
	chat("kimi-code", "Kimi Code", "KIMI_API_KEY", "https://api.kimi.com/coding/v1", "https://www.kimi.com/code", { modelsDevKey: undefined }),
	{
		id: "minimax",
		label: "MiniMax",
		keyUrl: "https://platform.minimax.io",
		envNames: ["MINIMAX_API_KEY"],
		modelsDevKey: "minimax",
		droidProvider: "anthropic",
		baseUrl: "https://api.minimax.io/anthropic",
		},
	chat("minimax-code", "MiniMax Token Plan", "MINIMAX_CODE_API_KEY", "https://api.minimax.io/v1", "https://platform.minimax.io", { modelsDevKey: "minimax-coding-plan" }),
	chat("alibaba-coding-plan", "Alibaba Coding Plan", "ALIBABA_CODING_PLAN_API_KEY", "https://coding-intl.dashscope.aliyuncs.com/v1", "https://modelstudio.console.alibabacloud.com/", {
		envNames: ["ALIBABA_CODING_PLAN_API_KEY", "DASHSCOPE_API_KEY"],
	}),
	chat("alibaba-token-plan", "Alibaba Token Plan", "ALIBABA_TOKEN_PLAN_API_KEY", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", "https://modelstudio.console.alibabacloud.com/"),
	chat("xiaomi", "Xiaomi MiMo", "XIAOMI_API_KEY", "https://api.xiaomimimo.com/v1", "https://platform.xiaomimimo.com"),
	chat("xiaomi-token-plan-sgp", "Xiaomi Token Plan (Singapore)", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "https://token-plan-sgp.xiaomimimo.com/v1", "https://platform.xiaomimimo.com/console/plan-manage"),
	chat("xiaomi-token-plan-ams", "Xiaomi Token Plan (Europe)", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "https://token-plan-ams.xiaomimimo.com/v1", "https://platform.xiaomimimo.com/console/plan-manage"),
	chat("xiaomi-token-plan-cn", "Xiaomi Token Plan (China)", "XIAOMI_TOKEN_PLAN_CN_API_KEY", "https://token-plan-cn.xiaomimimo.com/v1", "https://platform.xiaomimimo.com/console/plan-manage"),
	chat("groq", "Groq", "GROQ_API_KEY", "https://api.groq.com/openai/v1", "https://console.groq.com/keys"),
	chat("cerebras", "Cerebras", "CEREBRAS_API_KEY", "https://api.cerebras.ai/v1", "https://cloud.cerebras.ai/platform/"),
	chat("together", "Together", "TOGETHER_API_KEY", "https://api.together.xyz/v1", "https://api.together.xyz/settings/api-keys", { modelsDevKey: "togetherai" }),
	chat("fireworks", "Fireworks", "FIREWORKS_API_KEY", "https://api.fireworks.ai/inference/v1", "https://app.fireworks.ai/settings/users/api-keys", { modelsDevKey: "fireworks-ai" }),
	chat("nvidia", "NVIDIA", "NVIDIA_API_KEY", "https://integrate.api.nvidia.com/v1", "https://org.ngc.nvidia.com/setup/personal-keys"),
	chat("huggingface", "Hugging Face", "HUGGINGFACE_HUB_TOKEN", "https://router.huggingface.co/v1", "https://huggingface.co/settings/tokens", { envNames: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"] }),
	chat("novita", "Novita", "NOVITA_API_KEY", "https://api.novita.ai/openai/v1", "https://novita.ai/settings/key-management", { modelsDevKey: "novita-ai" }),
	chat("venice", "Venice", "VENICE_API_KEY", "https://api.venice.ai/api/v1", "https://venice.ai/settings/api"),
	chat("baseten", "Baseten", "BASETEN_API_KEY", "https://inference.baseten.co/v1", "https://app.baseten.co/settings/api_keys"),
	chat("synthetic", "Synthetic", "SYNTHETIC_API_KEY", "https://api.synthetic.new/openai/v1", "https://dev.synthetic.new/docs/api/overview"),
	chat("siliconflow", "SiliconFlow", "SILICONFLOW_API_KEY", "https://api.siliconflow.com/v1", "https://cloud.siliconflow.com/account/ak"),
	chat("zenmux", "ZenMux", "ZENMUX_API_KEY", "https://zenmux.ai/api/v1", "https://zenmux.ai/settings/keys"),
	chat("kilo", "Kilo", "KILO_API_KEY", "https://api.kilo.ai/api/gateway", "https://app.kilo.ai"),
];

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isSafeUrl = (url: unknown) => {
	if (url === undefined) return true;
	try {
		const parsed = new URL(String(url));
		return parsed.protocol === "https:" || (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname));
	} catch {
		return false;
	}
};

// Saved keys are looked up by ID, so a reused ID would send one provider's key to another's server.
export function checkCustomProviders(custom: Provider[], builtin: Provider[] = PROVIDERS): { valid: Provider[]; problems: string[] } {
	const valid: Provider[] = [];
	const problems: string[] = [];
	const ids = new Set(builtin.map(p => p.id));
	const labels = new Set(builtin.map(p => p.label));
	for (const provider of Array.isArray(custom) ? custom : []) {
		const name = `Custom provider "${provider?.id}"`;
		// A name like "constructor" would find something on every plain object, not a saved key.
		if (typeof provider?.id !== "string" || !VALID_ID.test(provider.id) || provider.id in Object.prototype) problems.push(`${name} was skipped: IDs can only use letters, numbers, dots, dashes and underscores, and can't be a reserved word.`);
		else if (ids.has(provider.id)) problems.push(`${name} was skipped: that ID is already in use.`);
		else if (typeof provider.label !== "string" || !provider.label || labels.has(provider.label)) problems.push(`${name} was skipped: it needs its own label.`);
		else if (![provider.listUrl, provider.baseUrl, provider.verifyUrl].every(isSafeUrl)) problems.push(`${name} was skipped: its URLs must use https, or http on this computer only.`);
		else {
			valid.push({ ...provider, envNames: Array.isArray(provider.envNames) ? provider.envNames : [] });
			ids.add(provider.id);
			labels.add(provider.label);
		}
	}
	return { valid, problems };
}

export const allProviders = (custom: Provider[], builtin: Provider[] = PROVIDERS) => [...builtin, ...checkCustomProviders(custom, builtin).valid];
