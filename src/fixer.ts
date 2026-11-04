// A small local process for models whose host rejects valid parts of Droid's tool definitions.
// It runs only while those models are in use. Droid never gets the provider key for these models:
// it gets a local token that's useless anywhere else, and this process adds the real key to each request.

import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Provider } from "./providers";
import { selfArgs } from "./self";
import { fixerSecret, getKey as savedKey } from "./store";

export const FIXER_PORT = 47613;
const FIXER_ORIGIN = `http://127.0.0.1:${FIXER_PORT}`;
const IDLE_EXIT_MS = 30 * 60_000;

// Valid JSON Schema, but Gemini's API rejects these fields.
const UNSUPPORTED_FIELDS = new Set(["exclusiveMinimum", "exclusiveMaximum"]);

export const needsToolFix = (provider: Provider, modelId: string) => provider.fixToolSchemas?.some(prefix => modelId.startsWith(prefix)) ?? false;

export const fixerBaseUrl = (providerId: string) => `${FIXER_ORIGIN}/p/${providerId}`;

// The provider URL behind an entry, whether it connects directly or through this process.
export function realBaseUrl(baseUrl: unknown, providers: Provider[]): string {
	const url = String(baseUrl ?? "");
	if (!url.startsWith(`${FIXER_ORIGIN}/p/`)) return url;
	return providers.find(p => fixerBaseUrl(p.id) === url)?.baseUrl ?? url;
}

export function simplifySchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(simplifySchema);
	if (!node || typeof node !== "object") return node;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (UNSUPPORTED_FIELDS.has(key)) continue;
		// Names under "properties" are the tool's own parameters, not schema fields.
		result[key] = key === "properties" && value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, prop]) => [name, simplifySchema(prop)])) : simplifySchema(value);
	}
	return result;
}

// biome-ignore lint: tool definitions are untyped JSON.
export const simplifyTools = (tools: any[]) => tools.map(tool => (tool?.function?.parameters ? { ...tool, function: { ...tool.function, parameters: simplifySchema(tool.function.parameters) } } : tool));

function rewriteBody(body: string): string {
	try {
		const parsed = JSON.parse(body);
		return Array.isArray(parsed.tools) ? JSON.stringify({ ...parsed, tools: simplifyTools(parsed.tools) }) : body;
	} catch {
		return body;
	}
}

const hmac = (secret: string, message: string) => createHmac("sha256", secret).update(message).digest("hex");
const proofFor = (secret: string, nonce: string, instance: string) => hmac(secret, `proof:${nonce}:${instance}`);

// Tied to one run of the process, so a token seen by something else stops working at the next restart.
export const localToken = (secret: string, instance: string) => hmac(secret, `token:${instance}`);

function sameText(a: string, b: string) {
	const [first, second] = [Buffer.from(a), Buffer.from(b)];
	return first.length === second.length && timingSafeEqual(first, second);
}

interface FixerOptions {
	port?: number;
	idleExitMs?: number;
	secret?: string;
	getKey?: (providerId: string) => string | undefined;
}

// Providers are read for each request, so a changed address takes effect at once.
export function serveFixer(getProviders: () => Provider[], { port = FIXER_PORT, idleExitMs = IDLE_EXIT_MS, secret = fixerSecret(), getKey = savedKey }: FixerOptions = {}) {
	const instance = randomBytes(16).toString("hex");
	const token = localToken(secret, instance);
	let lastUse = Date.now();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		idleTimeout: 0,
		async fetch(req) {
			lastUse = Date.now();
			const url = new URL(req.url);
			if (url.pathname === "/health") return Response.json({ app: "droid-models", instance, proof: proofFor(secret, url.searchParams.get("nonce") ?? "", instance) });
			const match = url.pathname.match(/^\/p\/([^/]+)(\/.*)$/);
			const provider = getProviders().find(p => p.id === match?.[1]);
			if (!match || !provider?.baseUrl) return Response.json({ error: { message: "Unknown provider" } }, { status: 404 });
			// Without this, any program on this computer could spend the user's credit through here.
			const usesApiKeyHeader = req.headers.has("x-api-key");
			const presented = usesApiKeyHeader ? (req.headers.get("x-api-key") ?? "") : (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
			if (!sameText(presented, token)) return Response.json({ error: { message: "Invalid local token" } }, { status: 401 });
			const key = getKey(provider.id);
			if (!key) return Response.json({ error: { message: `No key saved for ${provider.label}` } }, { status: 401 });
			const headers = new Headers(req.headers);
			headers.delete("host");
			headers.delete("content-length");
			headers.set(usesApiKeyHeader ? "x-api-key" : "authorization", usesApiKeyHeader ? key : `Bearer ${key}`);
			const hasBody = req.method !== "GET" && req.method !== "HEAD";
			try {
				const upstream = await fetch(`${provider.baseUrl}${match[2]}${url.search}`, { method: req.method, headers, body: hasBody ? rewriteBody(await req.text()) : undefined, redirect: "manual" });
				// A redirect could lead to a different host, so it's a failure rather than something to follow.
				if (upstream.status >= 300 && upstream.status < 400) return Response.json({ error: { message: `${provider.label} tried to redirect this request` } }, { status: 502 });
				const responseHeaders = new Headers(upstream.headers);
				responseHeaders.delete("content-encoding");
				responseHeaders.delete("content-length");
				return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
			} catch {
				return Response.json({ error: { message: `Couldn't reach ${provider.label}` } }, { status: 502 });
			}
		},
	});
	const idleCheck = setInterval(() => {
		if (server.pendingRequests === 0 && Date.now() - lastUse > idleExitMs) process.exit(0);
	}, Math.min(idleExitMs, 60_000));
	idleCheck.unref();
	return server;
}

export type FixerCheck = { status: "ours"; instance: string } | { status: "stranger" } | { status: "absent" };

// Anything could be listening on the port, so it has to prove it knows this account's secret.
export async function checkFixer(origin = FIXER_ORIGIN, secret = fixerSecret()): Promise<FixerCheck> {
	const nonce = randomBytes(16).toString("hex");
	let response: Response;
	try {
		response = await fetch(`${origin}/health?nonce=${nonce}`, { redirect: "error", signal: AbortSignal.timeout(1000) });
	} catch {
		return { status: "absent" };
	}
	try {
		const body = (await response.json()) as { proof?: unknown; instance?: unknown };
		return typeof body?.instance === "string" && body.proof === proofFor(secret, nonce, body.instance) ? { status: "ours", instance: body.instance } : { status: "stranger" };
	} catch {
		return { status: "stranger" };
	}
}

// Droid runs the key command before using a model, so this starts the process exactly when it's needed.
// Returns the token Droid should use, or null if something else may be on the port.
export async function startFixerAndGetToken(): Promise<string | null> {
	const secret = fixerSecret();
	let check = await checkFixer(FIXER_ORIGIN, secret);
	if (check.status === "absent") {
		const [command, ...args] = selfArgs();
		spawn(command as string, [...args, "fixer"], { detached: true, stdio: "ignore" }).unref();
		const deadline = Date.now() + 8000;
		while (check.status === "absent" && Date.now() < deadline) {
			await Bun.sleep(100);
			check = await checkFixer(FIXER_ORIGIN, secret);
		}
	}
	return check.status === "ours" ? localToken(secret, check.instance) : null;
}
