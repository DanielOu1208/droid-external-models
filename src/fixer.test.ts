import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toEntry, describeModel } from "./catalog";
import { findLeftovers } from "./cleanup";
import { isOwnedBy } from "./droid";
import { checkFixer, fixerBaseUrl, localToken, needsToolFix, realBaseUrl, serveFixer, simplifySchema, simplifyTools } from "./fixer";
import type { Provider } from "./providers";
import { DEFAULT_SETTINGS } from "./store";

const droidLikeTool = { type: "function", function: { name: "ToolSearch", description: "d", parameters: { $schema: "x", type: "object", properties: { query: { type: "string", pattern: "a" }, max_results: { anyOf: [{ type: "integer", exclusiveMinimum: 0 }, { type: "null" }] }, exclusiveMinimum: { type: "string" } }, additionalProperties: false } } };

describe("simplifying tool definitions", () => {
	test("removes only the rejected field, and leaves a parameter with that name", () => {
		const out = simplifySchema(droidLikeTool.function.parameters) as Record<string, any>;
		expect(out.properties.max_results).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
		expect(out.properties.exclusiveMinimum).toEqual({ type: "string" });
		expect(out.properties.query).toEqual({ type: "string", pattern: "a" });
		expect(out.additionalProperties).toBe(false);
		expect(out.$schema).toBe("x");
	});

	test("leaves everything else about a tool alone", () => {
		const [tool] = simplifyTools([droidLikeTool]);
		expect(tool.type).toBe("function");
		expect(tool.function.name).toBe("ToolSearch");
		expect(JSON.stringify(tool)).not.toContain('"exclusiveMinimum":0');
	});
});

describe("the local fixer", () => {
	const provider: Provider = { id: "host", label: "Host", envNames: ["X"], droidProvider: "generic-chat-completion-api", fixToolSchemas: ["google/"] };
	let upstream: ReturnType<typeof Bun.serve>;
	let fixer: ReturnType<typeof serveFixer>;
	let seen: { path: string; auth: string | null; body: any }[] = [];
	const SECRET = "real-secret";
	const origin = () => `http://127.0.0.1:${fixer.port}`;
	async function tokenOf(url = origin(), secret = SECRET) {
		const check = await checkFixer(url, secret);
		if (check.status !== "ours") throw new Error("expected our fixer");
		return localToken(secret, check.instance);
	}

	beforeAll(() => {
		upstream = Bun.serve({
			port: 0,
			async fetch(req) {
				const text = await req.text();
				seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: text ? JSON.parse(text) : null });
				if (new URL(req.url).pathname.endsWith("/fail")) return Response.json({ error: "nope" }, { status: 400 });
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("data: one\n\n"));
						controller.enqueue(new TextEncoder().encode("data: two\n\n"));
						controller.close();
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			},
		});
		provider.baseUrl = `http://localhost:${upstream.port}/v1`;
		fixer = serveFixer(() => [provider], { port: 0, idleExitMs: 3_600_000, secret: SECRET, getKey: () => "real-provider-key" });
	});

	afterAll(() => {
		fixer.stop(true);
		upstream.stop(true);
	});

	const post = async (path: string, body: unknown, key?: string) => fetch(`${origin()}${path}`, { method: "POST", headers: { Authorization: `Bearer ${key ?? (await tokenOf())}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

	test("rewrites tools, keeps the rest, swaps in the real key, and streams the reply", async () => {
		seen = [];
		const response = await post("/p/host/chat/completions", { model: "google/x", stream: true, messages: [{ role: "user", content: "hi" }], tools: [droidLikeTool] });
		expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const [request] = seen;
		expect(request?.path).toBe("/v1/chat/completions");
		expect(request?.auth).toBe("Bearer real-provider-key");
		expect(request?.body.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(request?.body.stream).toBe(true);
		expect(JSON.stringify(request?.body.tools)).not.toContain('"exclusiveMinimum":0');
	});

	test("passes errors straight back", async () => {
		const response = await post("/p/host/fail", { tools: [] });
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "nope" });
	});

	test("a request without the local token gets nowhere, and the key is never used", async () => {
		seen = [];
		for (const key of ["wrong-token", "real-provider-key", ""]) {
			const response = await post("/p/host/chat/completions", { model: "x" }, key);
			expect(response.status).toBe(401);
			expect(await response.text()).not.toContain("real-provider-key");
		}
		const noHeader = await fetch(`${origin()}/p/host/chat/completions`, { method: "POST", body: "{}" });
		expect(noHeader.status).toBe(401);
		expect(seen).toEqual([]);
	});

	test("the real key goes in whichever header Droid used", async () => {
		seen = [];
		const response = await fetch(`${origin()}/p/host/messages`, { method: "POST", headers: { "x-api-key": await tokenOf() }, body: "{}" });
		await response.text();
		expect(response.status).toBe(200);
		expect(seen[0]?.auth).toBeNull();
	});

	test("a token from an earlier run stops working", async () => {
		const first = serveFixer(() => [provider], { port: 0, idleExitMs: 3_600_000, secret: SECRET, getKey: () => "k" });
		const firstOrigin = `http://127.0.0.1:${first.port}`;
		const old = await tokenOf(firstOrigin);
		first.stop(true);
		const second = serveFixer(() => [provider], { port: 0, idleExitMs: 3_600_000, secret: SECRET, getKey: () => "k" });
		try {
			const response = await fetch(`http://127.0.0.1:${second.port}/p/host/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${old}` }, body: "{}" });
			expect(response.status).toBe(401);
		} finally {
			second.stop(true);
		}
	});

	test("a changed address takes effect on the next request", async () => {
		let target = "https://old.invalid";
		const moved = serveFixer(() => [{ ...provider, baseUrl: target }], { port: 0, idleExitMs: 3_600_000, secret: SECRET, getKey: () => "k" });
		try {
			target = provider.baseUrl as string;
			seen = [];
			const response = await fetch(`http://127.0.0.1:${moved.port}/p/host/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${await tokenOf(`http://127.0.0.1:${moved.port}`)}` }, body: "{}" });
			await response.text();
			expect(response.status).toBe(200);
			expect(seen).toHaveLength(1);
		} finally {
			moved.stop(true);
		}
	});

	test("refuses anything that isn't a known provider", async () => {
		seen = [];
		for (const path of ["/p/unknown/chat/completions", "/chat/completions", "/p/host"]) {
			expect((await post(path, {})).status).toBe(404);
		}
		expect(seen).toEqual([]);
	});

	test("won't let a provider redirect Droid's key somewhere else", async () => {
		const redirecting = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }) });
		const local = serveFixer(() => [{ ...provider, baseUrl: `http://localhost:${redirecting.port}` }], { port: 0, idleExitMs: 3_600_000, secret: SECRET, getKey: () => "k" });
		try {
			const url = `http://127.0.0.1:${local.port}`;
			const response = await fetch(`${url}/p/host/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${await tokenOf(url)}` }, body: "{}", redirect: "manual" });
			expect(response.status).toBe(502);
			expect(response.headers.get("location")).toBeNull();
		} finally {
			local.stop(true);
			redirecting.stop(true);
		}
	});

	test("proves itself with the account's secret", async () => {
		expect((await checkFixer(origin(), SECRET)).status).toBe("ours");
	});

	test("something else on the port is never trusted", async () => {
		const impostors: Response[] = [Response.json({ app: "droid-models" }), Response.json({ app: "droid-models", instance: "x", proof: "made-up" }), new Response("hello")];
		for (const answer of impostors) {
			const impostor = Bun.serve({ port: 0, fetch: () => answer.clone() });
			try {
				expect((await checkFixer(`http://127.0.0.1:${impostor.port}`, SECRET)).status).toBe("stranger");
			} finally {
				impostor.stop(true);
			}
		}
	});

	test("a different account's fixer doesn't pass either", async () => {
		expect((await checkFixer(origin(), "another-secret")).status).toBe("stranger");
	});

	test("an empty port is reported as empty", async () => {
		const closed = Bun.serve({ port: 0, fetch: () => new Response() });
		const url = `http://127.0.0.1:${closed.port}`;
		closed.stop(true);
		expect((await checkFixer(url, SECRET)).status).toBe("absent");
	});
});

describe("models that need the fix", () => {
	const provider: Provider = { id: "host", label: "Host", envNames: ["X"], droidProvider: "generic-chat-completion-api", baseUrl: "https://host.example/v1", fixToolSchemas: ["google/"] };
	const entry = (id: string) => toEntry(describeModel(id, undefined, undefined, provider, undefined), provider, DEFAULT_SETTINGS);

	test("only the matching models connect through it", () => {
		expect(needsToolFix(provider, "google/gemini-4")).toBe(true);
		expect(needsToolFix(provider, "openai/gpt-6")).toBe(false);
		expect(entry("openai/gpt-6").baseUrl).toBe("https://host.example/v1");
		expect(entry("openai/gpt-6").apiKeyHelper).toEndWith(" key host");
		expect(entry("openai/gpt-6").apiKeyHelperTtlMs).toBeUndefined();
		expect(entry("google/gemini-4").baseUrl).toBe(fixerBaseUrl("host"));
		expect(entry("google/gemini-4").apiKeyHelper).toEndWith(" key host --start-fixer");
		expect(entry("google/gemini-4").apiKeyHelperTtlMs).toBe(60_000);
	});

	test("entries that use it still count as the app's own", () => {
		expect(isOwnedBy({ apiKeyHelper: "/x/droid-models key host --start-fixer" }, provider)).toBe(true);
		expect(isOwnedBy({ apiKeyHelper: "/x/other-tool key host --start-fixer" }, provider)).toBe(false);
	});

	test("cleanup still sees through it to spot a hand-made duplicate", () => {
		expect(realBaseUrl(fixerBaseUrl("host"), [provider])).toBe("https://host.example/v1");
		const settings = { customModels: [{ model: "google/gemini-4", displayName: "Mine", baseUrl: "https://host.example/v1", apiKey: "k" }, { model: "google/gemini-4", displayName: "App [Host]", baseUrl: fixerBaseUrl("host"), apiKeyHelper: "/x/droid-models key host --start-fixer" }] };
		expect(findLeftovers(settings, [provider], { host: "k" }).map(l => l.kind)).toEqual(["duplicate"]);
	});
});
