import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityIndex, chooseModels, describeModel, isChatModel, normalizeModelName, planProvider, toEntry, toggleModel, verifyKey } from "./catalog";
import { findLeftovers, findStaleRefs, fingerprint, isPreTicked, modelRef, removeEntries } from "./cleanup";
import { isOwnedBy, mergeEntries } from "./droid";
import { findKeys } from "./importer";
import { allProviders, checkCustomProviders, PROVIDERS, type Provider } from "./providers";
import { helperCommand } from "./self";
import { sameEndpoint } from "./urls";
import { configDir, DEFAULT_SETTINGS, getKey, readKeys, removeKey, saveKey, type Settings } from "./store";

const settings: Settings = { ...DEFAULT_SETTINGS, selected: { router: ["known", "Acme/Seer-2", "Acme/Plain-1"] } };

const generic: Provider = {
	id: "router",
	label: "Router",
	envNames: ["ROUTER_API_KEY"],
	droidProvider: "generic-chat-completion-api",
	baseUrl: "https://router.example/v1",
};

const md = (extra = {}) => ({ name: "M", tool_call: true, limit: { context: 200000, output: 64000 }, cost: { output: 1 }, release_date: "2026-01-01", ...extra });
const model = (id: string, extra = {}, provider = generic) => describeModel(id, undefined, md(extra), provider, undefined);

let dir: string;
const savedEnv = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "droid-models-test-"));
	process.env.HOME = dir;
	delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
	process.env.HOME = savedEnv.HOME;
	if (savedEnv.XDG) process.env.XDG_CONFIG_HOME = savedEnv.XDG;
	rmSync(dir, { recursive: true, force: true });
});

describe("key store", () => {
	test("saves, reads and removes keys in a file only the owner can read", () => {
		saveKey("a", "secret-a");
		saveKey("b", "secret-b");
		expect(getKey("a")).toBe("secret-a");
		const path = join(configDir(), "keys.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(configDir()).mode & 0o777).toBe(0o700);
		removeKey("a");
		expect(readKeys()).toEqual({ b: "secret-b" });
	});
});

describe("describeModel", () => {
	test("uses a provider's fields when models.dev has no entry", () => {
		const m = describeModel("new/model", { name: "New", context_length: 300000, top_provider: { max_completion_tokens: 9000 }, pricing: { completion: "0.000002" }, supported_parameters: ["tools"] }, undefined, generic, undefined);
		expect(m).toMatchObject({ name: "New", context: 300000, output: 9000, tools: true });
		expect(m.outputPrice).toBeCloseTo(2);
	});

	test("reads per-model protocols and strips /v1 for anthropic", () => {
		const provider = { ...generic, droidProvider: undefined, baseUrl: undefined };
		const api = (kind: string, base_url: string) => ({ api: { [kind]: { base_url } } });
		expect(describeModel("a", api("messages", "https://x/anthropic/v1"), undefined, provider, undefined)).toMatchObject({ droidProvider: "anthropic", baseUrl: "https://x/anthropic" });
		expect(describeModel("b", api("responses", "https://x/openai/v1"), undefined, provider, undefined)).toMatchObject({ droidProvider: "openai", baseUrl: "https://x/openai/v1" });
		expect(describeModel("c", api("generate-content", "https://x/google"), undefined, provider, undefined).droidProvider).toBeUndefined();
	});
});

describe("choosing models", () => {
	const available = [model("a"), model("b"), model("c")];
	const chosen = (s: Settings) => chooseModels(available, generic, s).map(m => m.id);
	const none: Settings = { ...DEFAULT_SETTINGS };

	test("nothing goes into Droid until the user ticks it", () => {
		expect(chosen(none)).toEqual([]);
	});

	test("only ticked models count, and ticking twice undoes it", () => {
		const one = toggleModel(none, generic, "b");
		expect(chosen(one)).toEqual(["b"]);
		const two = toggleModel(one, generic, "c");
		expect(chosen(two)).toEqual(["b", "c"]);
		expect(chosen(toggleModel(two, generic, "b"))).toEqual(["c"]);
	});

	test("a new model appearing changes nothing", () => {
		const ticked = toggleModel(none, generic, "a");
		const withNew = [model("brand-new", { release_date: "2027-01-01" }), ...available];
		expect(chooseModels(withNew, generic, ticked).map(m => m.id)).toEqual(["a"]);
	});

	test("one provider's ticks don't touch another's", () => {
		const other = { ...generic, id: "other" };
		const ticked = toggleModel(none, generic, "a");
		expect(chooseModels(available, other, ticked)).toEqual([]);
	});
});

describe("what's offered", () => {
	const listing = (data: unknown[]) => Bun.serve({ port: 0, fetch: () => Response.json({ data }) });

	test("models that can't work in Droid aren't listed, and everything else is", async () => {
		const server = listing([{ id: "normal" }, { id: "free-one:free" }, { id: "stealth/secret" }, { id: "x:batch" }, { id: "no-tools", supported_parameters: ["temperature"] }, { id: "gpt-image-9" }]);
		try {
			const plan = await planProvider({ ...generic, listUrl: `http://localhost:${server.port}/` }, "k", DEFAULT_SETTINGS, {});
			expect(plan.available.map(m => m.id).sort()).toEqual(["free-one:free", "normal", "stealth/secret"]);
			expect(plan.entries).toEqual([]);
		} finally {
			server.stop(true);
		}
	});

	test("a ticked model the provider stops listing is reported, not dropped", async () => {
		const server = listing([{ id: "still-here" }]);
		try {
			const plan = await planProvider({ ...generic, listUrl: `http://localhost:${server.port}/` }, "k", { ...DEFAULT_SETTINGS, selected: { router: ["still-here", "retired"] } }, {});
			expect(plan.selected.map(m => m.id)).toEqual(["still-here"]);
			expect(plan.missing).toEqual(["retired"]);
		} finally {
			server.stop(true);
		}
	});
});

describe("toEntry", () => {
	test("holds a command that calls this app, never a key", () => {
		const entry = toEntry(model("a"), generic, settings);
		expect(entry.apiKeyHelper).toBe(helperCommand("router"));
		expect(entry.apiKeyHelper).toEndWith(" key router");
		expect(entry.apiKeyHelper).not.toContain("omp");
		expect(entry.apiKey).toBeUndefined();
		expect(entry.maxOutputTokens).toBe(32000);
		expect(entry.noImageSupport).toBe(true);
	});

	test("omits reasoning effort a model doesn't support", () => {
		const options = { reasoning: true, reasoning_options: [{ type: "effort", values: ["max"] }] };
		expect(toEntry(model("a", options), generic, settings).reasoningEffort).toBeUndefined();
		expect(toEntry(model("b", { reasoning: true }), generic, settings).reasoningEffort).toBe("high");
		expect(toEntry(model("c", { reasoning: true }), generic, { ...settings, reasoningEffort: null }).reasoningEffort).toBeUndefined();
	});
});

describe("talking to providers", () => {
	const modelsDev = { router: { models: { known: md() } } };

	async function withServer<T>(respond: (req: Request) => Response, use: (url: string) => Promise<T>) {
		const server = Bun.serve({ port: 0, fetch: respond });
		try {
			return await use(`http://localhost:${server.port}/models`);
		} finally {
			server.stop(true);
		}
	}
	const withStatus = (status: number) => () => Response.json({ data: [{ id: "known" }] }, { status });
	const plan = (status: number) => withServer(withStatus(status), url => planProvider({ ...generic, modelsDevKey: "router", listUrl: url }, "fake-key", settings, modelsDev));

	test("adds nothing when the provider rejects the key", async () => {
		for (const status of [401, 403]) expect(await plan(status)).toMatchObject({ keyRejected: true, entries: [] });
	});

	test("falls back to models.dev when the list is just unavailable", async () => {
		const result = await plan(500);
		expect(result).toMatchObject({ keyRejected: false, listSource: "models.dev" });
		expect(result.entries).toHaveLength(1);
	});

	test("uses the provider's list when it answers", async () => {
		expect(await plan(200)).toMatchObject({ keyRejected: false, listSource: "provider API", listed: 1 });
	});

	test("verifies a key only when the URL really needs one", async () => {
		const needsKey = (req: Request) => (req.headers.get("authorization") === "Bearer good" ? Response.json({ data: [] }) : new Response("no", { status: 401 }));
		const check = (key: string, respond: (req: Request) => Response) => withServer(respond, url => verifyKey({ ...generic, listUrl: url }, key));
		expect(await check("good", needsKey)).toBe("accepted");
		expect(await check("bad", needsKey)).toBe("rejected");
		expect(await check("anything", withStatus(200))).toBe("unverified");
		expect(await verifyKey(generic, "no-url")).toBe("unverified");
	});

	test("refuses a Claude subscription token without sending it anywhere", async () => {
		let called = false;
		const result = await withServer(() => { called = true; return new Response(); }, url => verifyKey({ ...generic, listUrl: url }, "sk-ant-oat01-abc"));
		expect(result).toBe("subscription");
		expect(called).toBe(false);
	});
});

describe("vision and other modalities", () => {
	const withInputs = (input: string[], output = ["text"], tool_call = true) => ({ tool_call, modalities: { input, output } });

	test("a host that reports nothing still gets the model's real abilities", async () => {
		const modelsDev = {
			openrouter: { models: { "acme/seer-2": withInputs(["text", "image"]) } },
			small: { models: { "seer-2": withInputs(["text"]) } },
		};
		const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: [{ id: "Acme/Seer-2", pricing: { completion: "0.000001" } }, { id: "Acme/Plain-1", pricing: { completion: "0.000001" } }] }) });
		try {
			const plan = await planProvider({ ...generic, listUrl: `http://localhost:${server.port}/models` }, "k", settings, modelsDev);
			const noImage = Object.fromEntries(plan.entries.map(e => [e.model, e.noImageSupport]));
			expect(noImage).toEqual({ "Acme/Seer-2": false, "Acme/Plain-1": true });
		} finally {
			server.stop(true);
		}
	});

	test("OpenRouter wins, otherwise the majority decides", () => {
		const index = capabilityIndex({
			a: { models: { one: withInputs(["text"]), two: withInputs(["text", "image"]), three: withInputs(["text", "image"]) } },
			b: { models: { one: withInputs(["text"]), two: withInputs(["text"]), three: withInputs(["text", "image"]) } },
			c: { models: { one: withInputs(["text", "image"]), two: withInputs(["text"]) } },
			openrouter: { models: { "lab/two": withInputs(["text", "image"]) } },
		});
		expect(index.get("one")?.image).toBe(false);
		expect(index.get("two")?.image).toBe(true);
		expect(index.get("three")?.image).toBe(true);
	});

	test("a provider's own data beats anything borrowed", () => {
		const known = { image: true };
		expect(describeModel("x", undefined, withInputs(["text"]), generic, undefined, known).image).toBe(false);
		expect(describeModel("x", { architecture: { input_modalities: ["text"] } }, undefined, generic, undefined, known).image).toBe(false);
		expect(describeModel("x", undefined, undefined, generic, undefined, known).image).toBe(true);
	});

	test("prices and limits are never borrowed from another host", () => {
		const m = describeModel("x", undefined, undefined, generic, undefined, { image: true, tools: true });
		expect(m.outputPrice).toBeUndefined();
		expect(m.context).toBeUndefined();
		expect(m.reasoning).toBeUndefined();
	});

	test("with no data at all, a vision name counts, and an ordinary name doesn't", () => {
		const image = (id: string) => describeModel(id, undefined, undefined, generic, undefined).image;
		for (const id of ["glm-5v-turbo", "glm-4.6v", "syn:small:vision", "nvidia/Nemotron-3.5-Super-VL-120B"]) expect(image(id)).toBe(true);
		for (const id of ["deepseek-v4-flash", "glm-5.3", "v4-model", "gpt-6"]) expect(image(id)).toBeUndefined();
	});

	test("image, video, speech and embedding models can't be chosen as chat models", async () => {
		for (const id of ["gpt-image-2", "grok-imagine-video-1.5", "gemini-2.5-pro-preview-tts", "text-embedding-3-large", "whisper-1", "dall-e-3", "sora-2", "openai/gpt-oss-safeguard-20b", "omni-moderation-latest", "wan2.7-i2v", "bge-reranker"]) {
			expect(isChatModel(describeModel(id, undefined, undefined, generic, undefined))).toBe(false);
		}
		for (const id of ["gpt-6-luna", "glm-5v-turbo", "gemini-4-argon", "qwen3.8-omni-flash"]) {
			expect(isChatModel(describeModel(id, undefined, undefined, generic, undefined))).toBe(true);
		}
		expect(isChatModel(describeModel("odd-name", undefined, withInputs(["text"], ["video"]), generic, undefined))).toBe(false);
	});

	test("normalizes hosts' naming differences", () => {
		expect(normalizeModelName("zai-org/GLM-5.3-Flash")).toBe("glm-5.3-flash");
		expect(normalizeModelName("z-ai/glm-5.3-flash:free")).toBe("glm-5.3-flash");
		expect(normalizeModelName("zai-org/GLM-5.2-FP8")).toBe("glm-5.2");
		expect(normalizeModelName("some_lab/my_model")).toBe("my-model");
	});
});

describe("older models already in Droid", () => {
	const url = "https://router.example/v1";
	const app = { model: "lab/a", displayName: "A [Router]", baseUrl: url, apiKeyHelper: "/x/droid-models key router" };
	const dup = { model: "lab/a", displayName: "My A", baseUrl: `${url}/`, apiKey: "pasted", id: "custom:My-A-0", index: 0 };
	const extra = { model: "lab/b", displayName: "My B", baseUrl: url, apiKey: "pasted", index: 1 };
	const other = { model: "a", displayName: "A Elsewhere", baseUrl: "https://else.example/v1", apiKey: "other", index: 2 };
	const inUse = { model: "c", displayName: "C Elsewhere", baseUrl: "https://else.example/v1", apiKey: "other", index: 3 };
	const droid = () => ({
		theme: "dark",
		sessionDefaultSettings: { specModeModel: "custom:C-Elsewhere-0", model: "claude-opus-5-5" },
		missionModelSettings: { workerModel: "custom:My-A-0", validatorModel: "custom:Gone-Model-0" },
		customModels: [dup, extra, other, inUse, app],
	});
	const keys = { router: "pasted" };
	const kinds = () => Object.fromEntries(findLeftovers(droid(), [generic], keys).map(l => [l.entry.displayName, l.kind]));

	test("sorts them by how they overlap, and never lists the app's own", () => {
		expect(kinds()).toEqual({ "My A": "duplicate", "My B": "sameProvider", "A Elsewhere": "other", "C Elsewhere": "other" });
	});

	test("a provider with no key saved doesn't count as overlap", () => {
		expect(findLeftovers({ customModels: [extra] }, [generic], {})[0]?.kind).toBe("other");
	});

	test("notes what uses each one, and protects what it can't replace", () => {
		const find = (name: string) => findLeftovers(droid(), [generic], keys).find(l => l.entry.displayName === name);
		expect(find("My A")).toMatchObject({ usedBy: ["mission workers"], removable: true });
		expect(find("C Elsewhere")).toMatchObject({ usedBy: ["spec mode"], removable: false });
		expect(find("A Elsewhere")).toMatchObject({ alsoVia: "Router", removable: true });
	});

	test("removing a duplicate moves settings to its replacement and leaves the rest", () => {
		const leftovers = findLeftovers(droid(), [generic], keys);
		const next = removeEntries(droid(), leftovers.filter(l => l.kind === "duplicate"));
		expect(next.customModels.map((e: { displayName: string }) => e.displayName)).toEqual(["My B", "A Elsewhere", "C Elsewhere", "A [Router]"]);
		expect(next.missionModelSettings.workerModel).toBe(modelRef(app));
		expect(next.missionModelSettings.workerModel).toBe("custom:A-[Router]-0");
		expect(next.sessionDefaultSettings).toEqual(droid().sessionDefaultSettings);
		expect(next.theme).toBe("dark");
		expect(next.customModels.map((e: { index?: number }) => e.index)).toEqual([0, 1, 2, undefined]);
	});

	test("an entry set up differently isn't called a duplicate, and isn't ticked", () => {
		const find = (entry: Record<string, unknown>, saved = "pasted") => findLeftovers({ customModels: [{ ...dup, ...entry }, app] }, [generic], { router: saved })[0];
		expect(find({})).toMatchObject({ kind: "duplicate", differences: [] });
		expect(isPreTicked(find({}) as never)).toBe(true);
		for (const [change, label] of [[{ extraHeaders: { "x-project": "billing" } }, "custom headers"], [{ extraArgs: { top_p: 1 } }, "custom parameters"], [{ maxOutputTokens: 500 }, "output limit"], [{ provider: "anthropic" }, "protocol"]] as const) {
			const leftover = find(change);
			expect(leftover?.kind).toBe("similar");
			expect(leftover?.differences).toEqual([label]);
			expect(isPreTicked(leftover as never)).toBe(false);
		}
	});

	test("another account's key is a real difference, and it's never shown", () => {
		const leftover = findLeftovers({ customModels: [dup, app] }, [generic], { router: "my-other-key" })[0];
		expect(leftover?.kind).toBe("similar");
		expect(leftover?.differences).toEqual(["key"]);
		expect(JSON.stringify(leftover?.differences)).not.toContain("pasted");
	});

	test("two entries for one model are told apart, so ticking one can't take the other", () => {
		const [exact, other] = findLeftovers({ customModels: [dup, { ...dup, displayName: "Work A", apiKey: "work-key", extraHeaders: { project: "billing" } }, app] }, [generic], keys);
		expect(exact?.kind).toBe("duplicate");
		expect(other?.kind).toBe("similar");
		expect(fingerprint(exact as never)).not.toBe(fingerprint(other as never));
		expect(fingerprint(other as never)).not.toContain("work-key");
	});

	test("Droid renumbering an entry doesn't change its identity", () => {
		const [first] = findLeftovers({ customModels: [dup, app] }, [generic], keys);
		const [second] = findLeftovers({ customModels: [{ ...dup, index: 7, id: "custom:Other-0" }, app] }, [generic], keys);
		expect(fingerprint(first as never)).toBe(fingerprint(second as never));
	});

	test("anything that changes how a model behaves counts as a difference", () => {
		const find = (entry: Record<string, unknown>) => findLeftovers({ customModels: [{ ...dup, ...entry }, { ...app, noImageSupport: false, maxOutputTokens: 32000 }] }, [generic], keys)[0];
		expect(find({ noImageSupport: true })?.differences).toEqual(["image support"]);
		expect(find({ noImageSupport: false })?.kind).toBe("duplicate");
		expect(find({ maxOutputTokens: 32000 })?.kind).toBe("duplicate");
		expect(find({ someNewDroidSetting: 1 })?.differences).toEqual(["someNewDroidSetting"]);
	});

	test("an entry with its own key helper is never called a duplicate, even with a matching key", () => {
		const leftover = findLeftovers({ customModels: [{ ...dup, apiKeyHelper: "/usr/local/bin/work-token", apiKeyHelperTtlMs: 1000 }, app] }, [generic], keys)[0];
		expect(leftover?.kind).toBe("similar");
		expect(leftover?.differences).toEqual(["key helper"]);
		expect(isPreTicked(leftover as never)).toBe(false);
	});

	test("a model that would move in with a limit of its own isn't ticked", () => {
		const leftover = findLeftovers({ customModels: [{ ...extra, maxOutputTokens: 256 }, app] }, [generic], keys)[0];
		expect(leftover?.kind).toBe("sameProvider");
		expect(leftover?.differences).toEqual(["output limit"]);
		expect(isPreTicked(leftover as never)).toBe(false);
	});

	test("a model that would move in with settings of its own isn't ticked", () => {
		const leftover = findLeftovers({ customModels: [{ ...extra, extraHeaders: { a: "b" } }, app] }, [generic], keys)[0];
		expect(leftover?.kind).toBe("sameProvider");
		expect(isPreTicked(leftover as never)).toBe(false);
	});

	test("flags settings that point at a model that's gone", () => {
		expect(findStaleRefs(droid())).toEqual([{ setting: "mission validators", value: "custom:Gone-Model-0" }]);
	});

	test("offers a key Droid is already using, ahead of other places", () => {
		process.env.ROUTER_API_KEY = "from-env";
		try {
			const found = findKeys([{ ...generic, envNames: ["ROUTER_API_KEY"] }], {}, [dup]);
			expect(found.map(f => [f.key, f.source, f.envName])).toEqual([["pasted", "Droid's custom models", undefined]]);
			expect(findKeys([generic], {}, [{ ...dup, apiKey: "$" + "{SOME_VAR}" }]).map(f => f.source)).toEqual(["shell environment"]);
		} finally {
			delete process.env.ROUTER_API_KEY;
		}
	});
});

describe("merging into Droid's settings", () => {
	test("a model kept because it's no longer listed gets the app's current path", () => {
		const moved = { model: "gone", displayName: "Gone [Router]", apiKeyHelper: "/deleted/droid-models key router", maxOutputTokens: 5 };
		const fixed = { ...moved, model: "gone2", apiKeyHelper: "/deleted/droid-models key router --start-fixer" };
		expect(mergeEntries([moved, fixed], [{ provider: generic, entries: [], missing: ["gone", "gone2"] }])).toEqual([
			{ ...moved, apiKeyHelper: helperCommand("router") },
			{ ...fixed, apiKeyHelper: helperCommand("router", true) },
		]);
	});

	const mine = { model: "old", displayName: "Old [Router]", apiKeyHelper: "/x/droid-models key router" };
	const legacy = { model: "older", displayName: "Older [Router]", apiKeyHelper: "/x/.bun/bin/omp token router" };
	const fresh = { model: "new", displayName: "New [Router]", apiKeyHelper: "/x/droid-models key router" };
	const handMade = { model: "x", displayName: "My Model", apiKey: "${KEY}" };
	const lookalike = { model: "y", displayName: "Y", apiKeyHelper: "/usr/local/bin/mint-token key router" };

	test("replaces this app's entries, including ones from older versions", () => {
		expect(mergeEntries([handMade, mine, legacy, lookalike], [{ provider: generic, entries: [fresh] }])).toEqual([handMade, lookalike, fresh]);
	});

	test("a ticked model the provider stopped listing keeps its entry", () => {
		expect(mergeEntries([mine], [{ provider: generic, entries: [fresh], missing: ["old"] }])).toEqual([{ ...mine, apiKeyHelper: helperCommand("router") }, fresh]);
	});

	test("leaves everything alone when a provider isn't updated", () => {
		expect(mergeEntries([handMade, mine], [])).toEqual([handMade, mine]);
	});

	test("recognizes its own entries wherever the app lives", () => {
		expect(isOwnedBy({ apiKeyHelper: helperCommand("router") }, generic)).toBe(true);
		expect(isOwnedBy({ apiKeyHelper: helperCommand("router", true) }, generic)).toBe(true);
		expect(isOwnedBy({ apiKeyHelper: "/moved/to/droid-models key router" }, generic)).toBe(true);
	});

	test("never claims a hand-made entry", () => {
		expect(isOwnedBy(handMade, generic)).toBe(false);
		expect(isOwnedBy(lookalike, generic)).toBe(false);
	});
});

describe("importing keys", () => {
	test("finds keys in known places, and skips providers that already have one", () => {
		const hermes = join(dir, ".hermes");
		Bun.spawnSync(["mkdir", "-p", hermes]);
		writeFileSync(join(hermes, ".env"), `export ROUTER_API_KEY="from-file"\nEMPTY_API_KEY=\n# COMMENTED_API_KEY=nope\n`);
		const found = findKeys([generic, { ...generic, id: "empty", envNames: ["EMPTY_API_KEY"] }, { ...generic, id: "commented", envNames: ["COMMENTED_API_KEY"] }], {});
		expect(found.map(f => [f.provider.id, f.key, f.source])).toEqual([["router", "from-file", "~/.hermes/.env"]]);
		expect(findKeys([generic], { router: "already" })).toEqual([]);
	});
});

describe("comparing endpoints", () => {
	test("hosts and trailing slashes don't matter, but path and query case do", () => {
		expect(sameEndpoint("https://API.example.com/v1/", "https://api.example.com/v1")).toBe(true);
		expect(sameEndpoint("https://x.example/tenant/A/v1", "https://x.example/tenant/a/v1")).toBe(false);
		expect(sameEndpoint("https://x.example/v1?team=A", "https://x.example/v1?team=a")).toBe(false);
		expect(sameEndpoint("http://x.example/v1", "https://x.example/v1")).toBe(false);
		expect(sameEndpoint("https://x.example:8443/v1", "https://x.example/v1")).toBe(false);
	});

	test("the importer won't send a key to a different tenant", () => {
		const provider = { ...generic, id: "tenant", baseUrl: "https://x.example/tenant/a/v1", envNames: [] };
		expect(findKeys([provider], {}, [{ baseUrl: "https://x.example/tenant/A/v1", apiKey: "their-key" }])).toEqual([]);
	});
});

describe("custom providers", () => {
	const custom = (more: Partial<Provider>): Provider => ({ id: "mine", label: "Mine", envNames: [], baseUrl: "https://mine.example/v1", droidProvider: "generic-chat-completion-api", ...more });
	const check = (...providers: Provider[]) => checkCustomProviders(providers, PROVIDERS);

	test("can't reuse an ID, so a saved key can't reach their server", () => {
		const { valid, problems } = check(custom({ id: "openai", label: "Fake OpenAI" }));
		expect(valid).toEqual([]);
		expect(problems[0]).toContain("already in use");
		expect(allProviders([custom({ id: "openai", label: "Fake OpenAI" })]).filter(p => p.id === "openai")).toHaveLength(1);
		expect(check(custom({}), custom({ label: "Second" })).valid.map(p => p.label)).toEqual(["Mine"]);
	});

	test("can't use a name every object already has", () => {
		for (const id of ["constructor", "toString", "hasOwnProperty", "valueOf"]) expect(check(custom({ id })).valid).toEqual([]);
	});

	test("can't put shell commands in an ID", () => {
		for (const id of ["x; rm -rf ~", "$(whoami)", "a b", "`id`", "../x", ""]) expect(check(custom({ id })).valid).toEqual([]);
		expect(check(custom({ id: "my.provider_2-x" })).valid).toHaveLength(1);
	});

	test("can't send keys over plain http to another machine", () => {
		expect(check(custom({ baseUrl: "http://mine.example/v1" })).valid).toEqual([]);
		expect(check(custom({ listUrl: "http://mine.example/models" })).valid).toEqual([]);
		expect(check(custom({ baseUrl: "http://localhost:1234/v1" })).valid).toHaveLength(1);
		expect(check(custom({ baseUrl: "http://127.0.0.1:1234/v1" })).valid).toHaveLength(1);
	});

	test("every argument in the key command is safe for a shell", () => {
		expect(helperCommand("x; touch /tmp/pwned")).toEndWith(` key 'x; touch /tmp/pwned'`);
		expect(helperCommand("host", true)).toEndWith(" key host --start-fixer");
	});
});

describe("redirects", () => {
	test("a key never follows one to a different host", async () => {
		let reached = false;
		const other = Bun.serve({ port: 0, fetch: () => { reached = true; return Response.json({ data: [] }); } });
		const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/models` } }) });
		try {
			expect(await verifyKey({ ...generic, listUrl: `http://localhost:${server.port}/models` }, "k")).toBe("unverified");
			expect(reached).toBe(false);
		} finally {
			server.stop(true);
			other.stop(true);
		}
	});

	test("a redirect on the same host still works", async () => {
		const server: ReturnType<typeof Bun.serve> = Bun.serve({ port: 0, fetch: req => (new URL(req.url).pathname === "/old" ? new Response(null, { status: 301, headers: { location: "/new" } }) : req.headers.get("authorization") ? Response.json({ data: [] }) : new Response("no", { status: 401 })) });
		try {
			expect(await verifyKey({ ...generic, listUrl: `http://localhost:${server.port}/old` }, "k")).toBe("accepted");
		} finally {
			server.stop(true);
		}
	});
});

describe("shipped providers", () => {
	test("never bridge a subscription login", () => {
		const subscriptionLogins = ["openai-codex", "openai-codex-device", "github-copilot", "cursor", "google-gemini-cli", "google-antigravity", "xai-oauth", "qwen-portal"];
		expect(PROVIDERS.filter(p => subscriptionLogins.includes(p.id))).toEqual([]);
	});

	test("each has a unique ID and label, a key name, and a way to find its protocol", () => {
		expect(new Set(PROVIDERS.map(p => p.id)).size).toBe(PROVIDERS.length);
		expect(new Set(PROVIDERS.map(p => p.label)).size).toBe(PROVIDERS.length);
		for (const p of PROVIDERS) {
			expect(p.envNames.length).toBeGreaterThan(0);
			expect(Boolean(p.droidProvider && p.baseUrl) || Boolean(p.listUrl)).toBe(true);
		}
	});

	test("nothing depends on OMP or Hermes at runtime", () => {
		for (const file of ["catalog.ts", "droid.ts", "sync.ts", "store.ts", "schedule.ts", "self.ts", "tui.tsx"]) {
			const code = readFileSync(join(import.meta.dir, file), "utf8");
			expect(code).not.toMatch(/spawn.*\b(omp|hermes)\b/);
		}
		expect(existsSync(join(import.meta.dir, "cli.ts"))).toBe(true);
	});
});
