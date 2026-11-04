import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan, describeModel, planProvider, type Model, type Plan } from "./catalog";
import { checkProvider, isDue, probeModel } from "./health";
import type { Provider } from "./providers";
import { DEFAULT_SETTINGS, getKey, type HealthMap, readHealth, readSettings, removeKey, saveKey, type Settings, tryExclusive, updateSettings, writeSettings } from "./store";
import * as store from "./store";
import { runSync } from "./sync";

type Handler = (req: Request, body: any) => Response | Promise<Response>;
const settings: Settings = { ...DEFAULT_SETTINGS, healthCheck: true, selected: { host: ["a", "b", "c"] } };
const tools = [{ type: "function", function: { name: "search", description: "d", parameters: { type: "object", properties: { limit: { type: "integer", exclusiveMinimum: 0 } } } } }];

let server: ReturnType<typeof Bun.serve>;
let calls: { path: string; body: any; headers: Headers }[];
let handler: Handler;
const ok = () => Response.json({ choices: [] });
const fail = (status: number, message = "nope") => Response.json({ error: { message } }, { status });

beforeEach(() => {
	calls = [];
	handler = ok;
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = await req.json().catch(() => null);
			calls.push({ path: new URL(req.url).pathname, body, headers: req.headers });
			return handler(req, body);
		},
	});
});
afterEach(() => server.stop(true));

const provider = (more: Partial<Provider> = {}): Provider => ({ id: "host", label: "Host", envNames: ["X"], droidProvider: "generic-chat-completion-api", baseUrl: `http://localhost:${server.port}`, ...more });
const model = (id: string, more: Partial<Model> = {}): Model => ({ ...describeModel(id, undefined, undefined, provider(), undefined), released: "2026-01-01", baseUrl: `http://localhost:${server.port}`, ...more });

describe("checking one model", () => {
	test("sends one tiny request with Droid's tools", async () => {
		expect(await probeModel(provider(), model("a"), "k", tools)).toEqual({ outcome: "ok", requests: 1 });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe("/chat/completions");
		expect(calls[0]?.body.max_tokens).toBe(16);
		expect(calls[0]?.body.tools).toEqual(tools);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer k");
	});

	test("applies the same tool fix the model gets in Droid", async () => {
		await probeModel(provider({ fixToolSchemas: ["google/"] }), model("google/a"), "k", tools);
		expect(JSON.stringify(calls[0]?.body.tools)).not.toContain("exclusiveMinimum");
	});

	test("uses each protocol's own format", async () => {
		await probeModel(provider(), model("a", { droidProvider: "anthropic" }), "k", tools);
		expect(calls[0]?.path).toBe("/v1/messages");
		expect(calls[0]?.headers.get("x-api-key")).toBe("k");
		expect(calls[0]?.body.tools[0].input_schema).toEqual(tools[0]?.function.parameters);
		await probeModel(provider(), model("a", { droidProvider: "openai" }), "k", tools);
		expect(calls[1]?.path).toBe("/responses");
		expect(calls[1]?.body.max_output_tokens).toBe(16);
		expect(calls[1]?.body.tools[0].name).toBe("search");
	});

	test("a rejected request means the model fails, with the reason, never the key", async () => {
		handler = () => fail(400, "Model secret-key is retired");
		expect(await probeModel(provider(), model("a"), "secret-key", tools)).toEqual({ outcome: "failed", reason: "Model … is retired", requests: 1 });
		expect(calls).toHaveLength(1);
	});

	test("account problems say nothing about the model", async () => {
		for (const status of [401, 402, 403, 429]) {
			handler = () => fail(status);
			expect(await probeModel(provider(), model("a"), "k", tools)).toEqual({ outcome: "unknown", requests: 1 });
		}
	});

	test("server errors get one retry", async () => {
		let n = 0;
		handler = () => (++n === 1 ? fail(503) : ok());
		expect(await probeModel(provider(), model("a"), "k", tools)).toEqual({ outcome: "ok", requests: 2 });
		expect(n).toBe(2);
		handler = () => fail(503, "no capacity");
		expect(await probeModel(provider(), model("a"), "k", tools)).toEqual({ outcome: "failed", reason: "no capacity", requests: 2 });
	});

	test("a model that only refuses the image works, without image support", async () => {
		handler = (_req, body) => (JSON.stringify(body).includes("image_url") ? fail(400, "no images") : ok());
		expect(await probeModel(provider(), model("a", { image: true }), "k", tools)).toEqual({ outcome: "ok", noImage: true, requests: 2 });
		expect(calls).toHaveLength(2);
	});
});

describe("stopping when the user opts out", () => {
	test("no retry after a server error", async () => {
		handler = () => fail(503);
		let allowed = 1;
		const result = await probeModel(provider(), model("a"), "k", tools, () => allowed-- > 0);
		expect(result).toEqual({ outcome: "cancelled", requests: 1 });
		expect(calls).toHaveLength(1);
	});

	test("no image fallback either", async () => {
		handler = () => fail(400);
		let allowed = 1;
		const result = await probeModel(provider(), model("a", { image: true }), "k", tools, () => allowed-- > 0);
		expect(result).toEqual({ outcome: "cancelled", requests: 1 });
		expect(calls).toHaveLength(1);
	});

	test("nothing at all if it's already off", async () => {
		expect(await probeModel(provider(), model("a"), "k", tools, () => false)).toEqual({ outcome: "cancelled", requests: 0 });
		expect(calls).toEqual([]);
	});
});

describe("redirects during a check", () => {
	test("the key isn't forwarded, and the model isn't blamed", async () => {
		const other = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [] }) });
		let reachedOther = 0;
		const counted = Bun.serve({ port: 0, fetch: () => { reachedOther++; return Response.json({ choices: [] }); } });
		handler = () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${counted.port}/x` } });
		try {
			expect(await probeModel(provider(), model("a", { droidProvider: "anthropic" }), "k", tools)).toEqual({ outcome: "unknown", requests: 1 });
			expect(reachedOther).toBe(0);
		} finally {
			other.stop(true);
			counted.stop(true);
		}
	});
});

describe("remembering that a host refuses images", () => {
	const withImage = () => buildPlan({ provider: provider(), keyRejected: false, listed: 1, listSource: "provider API", available: [model("a", { image: true, advertisedImage: true })], selected: [], missing: [], entries: [] }, settings);
	const old = () => new Date(Date.now() - 8 * 86_400_000).toISOString();
	const refuseImages: Handler = (_req, body) => (JSON.stringify(body).includes("image_url") ? fail(400) : ok());

	test("stays off through a recheck that's still refused", async () => {
		handler = refuseImages;
		const health: HealthMap = { host: { a: { status: "ok", checkedAt: old(), noImage: true } } };
		const result = await checkProvider(buildPlan(withImage(), settings, health.host), "k", settings, tools, health);
		expect(health.host?.a?.noImage).toBe(true);
		expect(result.plan.entries[0]?.noImageSupport).toBe(true);
		expect(JSON.stringify(calls[0]?.body)).toContain("image_url");
	});

	test("a fresh plan from saved results keeps images off", () => {
		const health = { a: { status: "ok" as const, checkedAt: new Date().toISOString(), noImage: true } };
		expect(buildPlan(withImage(), settings, health).entries[0]?.noImageSupport).toBe(true);
	});

	test("comes back only after an image really gets through", async () => {
		handler = ok;
		const health: HealthMap = { host: { a: { status: "ok", checkedAt: old(), noImage: true } } };
		const result = await checkProvider(buildPlan(withImage(), settings, health.host), "k", settings, tools, health);
		expect(health.host?.a?.noImage).toBeUndefined();
		expect(result.plan.entries[0]?.noImageSupport).toBe(false);
	});
});

describe("when checks are due", () => {
	const at = (ageMs: number, status: "ok" | "failed") => ({ status, checkedAt: new Date(Date.now() - ageMs).toISOString() });
	test("new models always, working ones weekly, failing ones hourly", () => {
		expect(isDue(undefined)).toBe(true);
		expect(isDue(at(6 * 86_400_000, "ok"))).toBe(false);
		expect(isDue(at(8 * 86_400_000, "ok"))).toBe(true);
		expect(isDue(at(1_800_000, "failed"))).toBe(false);
		expect(isDue(at(4_000_000, "failed"))).toBe(true);
	});
});

describe("checking a provider", () => {
	const ticked = (ids: string[]): Settings => ({ ...settings, selected: { host: ids } });
	const basePlan = (ids: string[], tick = ids): Plan => buildPlan({ provider: provider(), keyRejected: false, listed: ids.length, listSource: "provider API", available: ids.map(id => model(id)), selected: [], missing: [], entries: [] }, ticked(tick));
	const failOnly = (...ids: string[]): Handler => (_req, body) => (ids.includes(body.model) ? fail(400, `${body.model} is gone`) : ok());

	test("only ticked models are checked", async () => {
		await checkProvider(basePlan(["a", "b", "c"], ["b"]), "k", ticked(["b"]), tools, {});
		expect(calls.map(c => c.body.model)).toEqual(["b"]);
	});

	test("a failing model stays out, and nothing is added in its place", async () => {
		handler = failOnly("a");
		const health: HealthMap = {};
		const result = await checkProvider(basePlan(["a", "b", "c", "d"], ["a", "b"]), "k", ticked(["a", "b"]), tools, health);
		expect(result.plan.selected.map(m => m.id)).toEqual(["b"]);
		expect(result.failed).toEqual([{ model: "a", reason: "a is gone" }]);
		expect(result.outage).toBe(false);
		expect(health.host?.a?.status).toBe("failed");
		expect(calls.map(c => c.body.model).sort()).toEqual(["a", "b"]);
	});

	test("recent results aren't paid for twice", async () => {
		const health: HealthMap = {};
		await checkProvider(basePlan(["a", "b"]), "k", ticked(["a", "b"]), tools, health);
		const before = calls.length;
		await checkProvider(basePlan(["a", "b"]), "k", ticked(["a", "b"]), tools, health);
		expect(calls).toHaveLength(before);
	});

	test("a model that recovers comes back", async () => {
		const health: HealthMap = { host: { a: { status: "failed", checkedAt: new Date(Date.now() - 4_000_000).toISOString(), reason: "was down" } } };
		const result = await checkProvider(basePlan(["a", "b"]), "k", ticked(["a", "b"]), tools, health);
		expect(result.plan.selected.map(m => m.id)).toEqual(["a", "b"]);
		expect(health.host?.a?.status).toBe("ok");
	});

	test("if several all fail, it blames the provider and records nothing", async () => {
		handler = () => fail(400);
		const health: HealthMap = {};
		const result = await checkProvider(basePlan(["a", "b", "c"]), "k", ticked(["a", "b", "c"]), tools, health);
		expect(result.outage).toBe(true);
		expect(health).toEqual({});
		expect(result.plan.selected.map(m => m.id)).toEqual(["a", "b", "c"]);
	});

	test("one ticked model failing is just that model", async () => {
		handler = () => fail(400, "gone");
		const health: HealthMap = {};
		const result = await checkProvider(basePlan(["a"]), "k", ticked(["a"]), tools, health);
		expect(result.outage).toBe(false);
		expect(result.plan.selected).toEqual([]);
		expect(health.host?.a?.status).toBe("failed");
	});

	test("an account problem changes nothing", async () => {
		handler = () => fail(402, "Out of credit");
		const health: HealthMap = {};
		const result = await checkProvider(basePlan(["a", "b"]), "k", ticked(["a", "b"]), tools, health);
		expect(result.failed).toEqual([]);
		expect(result.plan.selected.map(m => m.id)).toEqual(["a", "b"]);
		expect(health.host).toEqual({});
	});

	test("stops as soon as the user changes something", async () => {
		let allowed = 1;
		const result = await checkProvider(basePlan(["a", "b", "c"]), "k", ticked(["a", "b", "c"]), tools, {}, () => allowed-- > 0);
		expect(result.aborted).toBe(true);
		expect(calls.length).toBeLessThan(3);
	});

	test("counts every request, not just every model", async () => {
		let n = 0;
		handler = () => (++n === 1 ? fail(503) : ok());
		const result = await checkProvider(basePlan(["a"]), "k", ticked(["a"]), tools, {});
		expect(result).toMatchObject({ checked: 1, requests: 2 });
	});

	test("a model that refuses images loses image support in Droid", async () => {
		handler = (_req, body) => (JSON.stringify(body).includes("image_url") ? fail(400) : ok());
		const plan = buildPlan({ provider: provider(), keyRejected: false, listed: 1, listSource: "provider API", available: [model("a", { image: true })], selected: [], missing: [], entries: [] }, ticked(["a"]));
		expect(plan.entries[0]?.noImageSupport).toBe(false);
		const result = await checkProvider(plan, "k", ticked(["a"]), tools, {});
		expect(result.plan.entries[0]?.noImageSupport).toBe(true);
	});
});

describe("syncing", () => {
	let dir: string;
	const savedHome = process.env.HOME;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "droid-models-health-"));
		process.env.HOME = dir;
		delete process.env.XDG_CONFIG_HOME;
		mkdirSync(join(dir, ".config", "droid-models"), { recursive: true });
		// A fresh list of Droid's tools, so these tests never launch Droid.
		writeFileSync(join(dir, ".config", "droid-models", "droid-tools.json"), JSON.stringify(tools));
		saveKey("host", "k");
	});
	afterEach(() => {
		process.env.HOME = savedHome;
		rmSync(dir, { recursive: true, force: true });
	});

	const useMock = (healthCheck: boolean, selected: string[] = ["a", "b"]) => {
		const base = `http://localhost:${server.port}`;
		handler = (req, body) => {
			const path = new URL(req.url).pathname;
			if (path === "/md") return Response.json({});
			if (path === "/models") return Response.json({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] });
			return body?.model === "a" ? fail(400, "gone") : ok();
		};
		writeSettings({ ...DEFAULT_SETTINGS, modelsDevUrl: `${base}/md`, healthCheck, selected: { host: selected } });
		return [provider({ listUrl: `${base}/models`, baseUrl: base })];
	};
	const modelRequests = () => calls.filter(c => c.path === "/chat/completions");
	const droidFile = () => join(dir, ".factory", "settings.json");
	const seedDroid = (entries: unknown[]) => {
		mkdirSync(join(dir, ".factory"), { recursive: true });
		writeFileSync(droidFile(), JSON.stringify({ customModels: entries }));
	};
	const droidModels = () => (JSON.parse(readFileSync(droidFile(), "utf8")).customModels as { model: string }[]).map(e => e.model);
	const owned = (model: string) => ({ model, displayName: `${model} [Host]`, apiKeyHelper: "/x/droid-models key host" });

	test("with the check off, not one model request is sent", async () => {
		const result = await runSync({ providers: useMock(false) });
		expect(modelRequests()).toEqual([]);
		expect(result.checked).toBe(0);
		expect(readHealth()).toEqual({});
		expect(result.added).toHaveLength(2);
	});

	test("Droid gets exactly what's ticked, and a newer listed model isn't added", async () => {
		await runSync({ providers: useMock(false, ["b"]) });
		expect(droidModels()).toEqual(["b"]);
	});

	test("nothing ticked means nothing added", async () => {
		await runSync({ providers: useMock(false, []) });
		expect(existsSync(droidFile())).toBe(false);
	});

	test("unticking removes a model, and hand-made entries stay", async () => {
		const providers = useMock(false, ["b"]);
		seedDroid([owned("a"), owned("b"), { model: "mine", displayName: "Mine" }]);
		await runSync({ providers });
		expect(droidModels().sort()).toEqual(["b", "mine"]);
	});

	test("a provider outage can't remove anything ticked", async () => {
		const providers = useMock(false);
		const base = `http://localhost:${server.port}`;
		const down = providers.map(p => ({ ...p, modelsDevKey: undefined, listUrl: `${base}/down` }));
		handler = (req) => (new URL(req.url).pathname === "/down" ? fail(503) : new URL(req.url).pathname === "/md" ? Response.json({}) : ok());
		seedDroid([owned("a"), owned("b")]);
		await runSync({ providers: down });
		expect(droidModels()).toEqual(["a", "b"]);
	});

	test("during an outage found by checks, an unticked model still goes and ticked ones stay", async () => {
		const providers = useMock(true, ["a", "b"]);
		const inner = handler;
		handler = (req, body) => (new URL(req.url).pathname === "/chat/completions" ? fail(400, "down") : inner(req, body));
		seedDroid([owned("a"), owned("b"), owned("c"), { model: "mine", displayName: "Mine" }]);
		const result = await runSync({ providers });
		expect(result.outages).toEqual(["Host"]);
		expect(droidModels().sort()).toEqual(["a", "b", "mine"]);
	});

	test("an outage doesn't add a newly ticked model", async () => {
		const providers = useMock(true, ["a", "b", "c"]);
		const inner = handler;
		handler = (req, body) => (new URL(req.url).pathname === "/chat/completions" ? fail(400, "down") : inner(req, body));
		seedDroid([owned("a"), owned("b")]);
		await runSync({ providers });
		expect(droidModels().sort()).toEqual(["a", "b"]);
	});

	test("a restart doesn't pay to test the same models again", async () => {
		const providers = useMock(true, ["a", "b"]);
		const inner = handler;
		let seen = 0;
		handler = (req, body) => {
			if (new URL(req.url).pathname !== "/chat/completions") return inner(req, body);
			// Changing a setting during the last test makes the whole sync start over.
			if (++seen === 2) updateSettings(s => ({ ...s, reasoningEffort: "low" }));
			return fail(400, "down");
		};
		seedDroid([owned("a"), owned("b")]);
		const result = await runSync({ providers });
		expect(result.outages).toEqual(["Host"]);
		expect(modelRequests()).toHaveLength(2);
		expect(result.requests).toBe(2);
		expect(result.checked).toBe(2);
	});

	test("a model cancelled partway isn't charged for again", async () => {
		const providers = useMock(true, ["a"]);
		const inner = handler;
		let seen = 0;
		handler = (req, body) => {
			if (new URL(req.url).pathname !== "/chat/completions") return inner(req, body);
			seen++;
			// The first request fails in a way that gets a retry, and the setting changes before it runs.
			updateSettings(s => ({ ...s, reasoningEffort: seen % 2 ? "low" : "medium" }));
			return fail(503, "busy");
		};
		seedDroid([owned("a")]);
		const result = await runSync({ providers });
		expect(modelRequests()).toHaveLength(1);
		expect(result.requests).toBe(1);
		expect(droidModels()).toEqual(["a"]);
	});

	test("a setting changed just before checks start can't be overruled by the older plan", async () => {
		const providers = useMock(false, ["a", "b"]);
		const realReadKeys = store.readKeys;
		const spy = spyOn(store, "readKeys").mockImplementationOnce(() => {
			updateSettings(s => ({ ...s, selected: { host: ["b"] } }));
			return realReadKeys();
		});
		await runSync({ providers });
		spy.mockRestore();
		expect(droidModels()).toEqual(["b"]);
	});

	test("a rejected key can't remove anything ticked", async () => {
		const providers = useMock(false);
		const inner = handler;
		handler = (req, body) => (new URL(req.url).pathname === "/models" ? fail(401) : inner(req, body));
		seedDroid([owned("a"), owned("b")]);
		const result = await runSync({ providers });
		expect(droidModels()).toEqual(["a", "b"]);
		expect(result.plans[0]?.keyRejected).toBe(true);
	});

	test("a ticked model the provider retired stays until it's unticked", async () => {
		const providers = useMock(false, ["b", "retired"]);
		seedDroid([owned("retired"), owned("b")]);
		await runSync({ providers });
		expect(droidModels().sort()).toEqual(["b", "retired"]);
		updateSettings(s => ({ ...s, selected: { host: ["b"] } }));
		await runSync({ providers });
		expect(droidModels()).toEqual(["b"]);
	});

	test("a key removed mid-sync doesn't bring its models back", async () => {
		const providers = useMock(false);
		seedDroid([]);
		const inner = handler;
		handler = async (req, body) => {
			if (new URL(req.url).pathname === "/models") removeKey("host");
			return inner(req, body);
		};
		await runSync({ providers });
		expect(droidModels()).toEqual([]);
	});

	test("opting out mid-check stops further paid requests", async () => {
		const providers = useMock(true);
		const inner = handler;
		let modelRequestsSeen = 0;
		handler = async (req, body) => {
			if (new URL(req.url).pathname === "/chat/completions" && ++modelRequestsSeen === 1) updateSettings(s => ({ ...s, healthCheck: false }));
			return inner(req, body);
		};
		await runSync({ providers });
		expect(modelRequests().length).toBeLessThanOrEqual(2);
	});

	test("each attempt sees a provider that just changed", async () => {
		const providers = useMock(false);
		const base = `http://localhost:${server.port}`;
		let listCalls = 0;
		const inner = handler;
		handler = async (req, body) => {
			if (new URL(req.url).pathname === "/models" && ++listCalls === 1) updateSettings(s => ({ ...s, reasoningEffort: null }));
			return inner(req, body);
		};
		const seen: (string | undefined)[] = [];
		await runSync({ providers: () => { const p = providers.map(x => ({ ...x, listUrl: seen.length === 0 ? `${base}/models` : `${base}/models?second=1` })); seen.push(p[0]?.listUrl); return p; } });
		expect(seen).toHaveLength(2);
		expect(calls.filter(c => c.path === "/models").length).toBe(2);
	});

	test("requests spent on a discarded attempt are still counted", async () => {
		const providers = useMock(true);
		const inner = handler;
		let once = true;
		handler = async (req, body) => {
			if (new URL(req.url).pathname === "/chat/completions" && once) {
				once = false;
				updateSettings(s => ({ ...s, reasoningEffort: null }));
			}
			return inner(req, body);
		};
		const result = await runSync({ providers });
		expect(result.requests).toBe(modelRequests().length);
		expect(result.requests).toBeGreaterThan(0);
	});

	test("syncs run one at a time, so a check isn't paid for twice", async () => {
		const providers = useMock(true);
		await Promise.all([runSync({ providers }), runSync({ providers }), runSync({ providers })]);
		const perModel = modelRequests().map(c => c.body.model);
		expect(new Set(perModel).size).toBe(perModel.length);
	});

	test("another copy already checking means this one doesn't pay", async () => {
		const providers = useMock(true);
		seedDroid([owned("a")]);
		const release = tryExclusive("health-check");
		try {
			const result = await runSync({ providers });
			expect(modelRequests()).toEqual([]);
			expect(result.checked).toBe(0);
			expect(result.problem).toContain("Another copy");
			// Its unchecked models must not be published while the other copy is checking them.
			expect(droidModels()).toEqual(["a"]);
		} finally {
			release?.();
		}
	});

	test("a dry run sends no model requests and writes nothing, even with the check on", async () => {
		await runSync({ dryRun: true, providers: useMock(true) });
		expect(modelRequests()).toEqual([]);
		expect(existsSync(droidFile())).toBe(false);
	});

	test("with the check on, failing models stay out of Droid and results are saved", async () => {
		const result = await runSync({ providers: useMock(true) });
		expect(result.checked).toBe(2);
		expect(result.failing).toEqual([{ provider: "Host", model: "a", reason: "gone" }]);
		expect(readHealth().host?.a?.status).toBe("failed");
		expect(droidModels()).toEqual(["b"]);
		expect(getKey("host")).toBe("k");
	});

	describe("upgrading from a version that added models by itself", () => {
		const writeOld = (raw: unknown) => writeFileSync(join(dir, ".config", "droid-models", "settings.json"), JSON.stringify(raw));
		const providersFor = (ids: string[]) => {
			const base = `http://localhost:${server.port}`;
			handler = (req) => {
				const path = new URL(req.url).pathname;
				return path === "/md" ? Response.json({}) : path === "/models" ? Response.json({ data: ids.map(id => ({ id })) }) : ok();
			};
			return { base, providers: [provider({ listUrl: `${base}/models`, baseUrl: base })] };
		};

		test("nothing in Droid disappears, and a new listed model isn't added", async () => {
			const { base, providers } = providersFor(["auto-1", "auto-2", "picked", "brand-new"]);
			writeOld({ modelsDevUrl: `${base}/md`, newestPerProvider: 2, pinned: {}, hidden: {}, skip: [":free"], maxOutputPrice: 3, minContext: 128000, customProviders: [{ id: "host", label: "Host", envNames: ["X"], droidProvider: "generic-chat-completion-api", baseUrl: base }] });
			seedDroid([owned("auto-1"), owned("auto-2")]);
			await runSync({ providers });
			expect(droidModels().sort()).toEqual(["auto-1", "auto-2"]);
			expect(readSettings().selected.host?.sort()).toEqual(["auto-1", "auto-2"]);
		});

		test("old picks count, unticked ones stay unticked, and it only runs once", async () => {
			const { base, providers } = providersFor(["a", "b", "c"]);
			writeOld({ modelsDevUrl: `${base}/md`, pinned: { host: ["c"] }, hidden: { host: ["b"] }, customProviders: [{ id: "host", label: "Host", envNames: ["X"], droidProvider: "generic-chat-completion-api", baseUrl: base }] });
			seedDroid([owned("a"), owned("b")]);
			await runSync({ providers });
			expect(readSettings().selected.host?.sort()).toEqual(["a", "c"]);
			updateSettings(s => ({ ...s, selected: { host: [] } }));
			await runSync({ providers });
			expect(readSettings().selected.host).toEqual([]);
			expect(droidModels()).toEqual([]);
			const stored = JSON.parse(readFileSync(join(dir, ".config", "droid-models", "settings.json"), "utf8"));
			expect(stored.pinned).toBeUndefined();
			expect(stored.newestPerProvider).toBeUndefined();
		});
	});
});

test("planning ignores health results unless they're passed in", async () => {
	handler = () => Response.json({ data: [{ id: "a" }, { id: "b" }] });
	const p = provider({ listUrl: `http://localhost:${server.port}/models` });
	const two = { ...settings, selected: { host: ["a", "b"] } };
	expect((await planProvider(p, "k", two, {})).selected.map(m => m.id)).toEqual(["a", "b"]);
	expect((await planProvider(p, "k", two, {}, { a: { status: "failed", checkedAt: "2026-01-01" } })).selected.map(m => m.id)).toEqual(["b"]);
});
