// Optional checks that send a model one tiny real request, on the user's own device and key.
// They only ever run after the user opts in, because each request costs a little.

import { buildPlan, type Model, type Plan } from "./catalog";
import { needsToolFix, simplifyTools } from "./fixer";
import type { Provider } from "./providers";
import type { HealthMap, ModelHealth, Settings } from "./store";

const RECHECK_WORKING_MS = 7 * 24 * 3_600_000;
const RECHECK_FAILED_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 45_000;
const CONCURRENT_CHECKS = 4;
const PROMPT = "Reply with only OK";
const PROBE_IMAGE = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mOIqjhBU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULABq5aFvaKWAGAAAAAElFTkSuQmCC";

export const isDue = (entry: ModelHealth | undefined, now = Date.now()) => {
	if (!entry) return true;
	const age = now - new Date(entry.checkedAt).getTime();
	return age >= (entry.status === "failed" ? RECHECK_FAILED_MS : RECHECK_WORKING_MS);
};

interface Attempt {
	status: number | null;
	reason?: string;
}

// biome-ignore lint: tool definitions are untyped JSON.
type Tool = any;

function buildRequest(provider: Provider, model: Model, key: string, tools: Tool[], withImage: boolean): { url: string; headers: Record<string, string>; body: unknown } {
	const fixed = needsToolFix(provider, model.id) ? simplifyTools(tools) : tools;
	if (model.droidProvider === "anthropic") {
		const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PROBE_IMAGE } };
		return {
			url: `${model.baseUrl}/v1/messages`,
			headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
			body: {
				model: model.id,
				max_tokens: 16,
				messages: [{ role: "user", content: withImage ? [image, { type: "text", text: PROMPT }] : PROMPT }],
				tools: fixed.map(t => ({ name: t.function?.name, description: t.function?.description, input_schema: t.function?.parameters })),
			},
		};
	}
	if (model.droidProvider === "openai") {
		const content = [{ type: "input_text", text: PROMPT }, ...(withImage ? [{ type: "input_image", image_url: `data:image/png;base64,${PROBE_IMAGE}` }] : [])];
		return {
			url: `${model.baseUrl}/responses`,
			headers: { Authorization: `Bearer ${key}` },
			body: { model: model.id, max_output_tokens: 16, store: false, input: [{ role: "user", content }], tools: fixed.map(t => ({ type: "function", name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters })) },
		};
	}
	const content = withImage ? [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_IMAGE}` } }] : PROMPT;
	return {
		url: `${model.baseUrl}/chat/completions`,
		headers: { Authorization: `Bearer ${key}` },
		body: { model: model.id, max_tokens: 16, temperature: 1, messages: [{ role: "user", content }], tools: fixed },
	};
}

function readableReason(text: string, key: string) {
	let message = text;
	try {
		const parsed = JSON.parse(text);
		message = parsed?.error?.message ?? parsed?.message ?? text;
	} catch {
		// Not JSON, so the raw text is the best there is.
	}
	return String(message).split(key).join("…").replace(/\s+/g, " ").trim().slice(0, 100);
}

async function attempt(provider: Provider, model: Model, key: string, tools: Tool[], withImage: boolean): Promise<Attempt> {
	const { url, headers, body } = buildRequest(provider, model, key, tools, withImage);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json", "User-Agent": "droid-models" },
			body: JSON.stringify(body),
			// The key must not follow a redirect, because it could lead to a different host.
			redirect: "manual",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (response.ok) {
			await response.body?.cancel();
			return { status: response.status };
		}
		return { status: response.status, reason: readableReason(await response.text(), key) };
	} catch (error) {
		return { status: error instanceof Error && error.name === "TimeoutError" ? 504 : null, reason: error instanceof Error && error.name === "TimeoutError" ? "Timed out" : "Couldn't connect" };
	}
}

const isOk = (a: Attempt) => a.status !== null && a.status >= 200 && a.status < 300;
const isServerProblem = (a: Attempt) => a.status !== null && a.status >= 500;
// These say something about the account, the connection or a redirect, not the model.
const saysNothingAboutModel = (a: Attempt) => a.status === null || [401, 402, 403, 429].includes(a.status) || (a.status >= 300 && a.status < 400);

export type ProbeResult = ({ outcome: "ok"; noImage?: boolean } | { outcome: "failed"; reason: string } | { outcome: "unknown" } | { outcome: "cancelled" }) & { requests: number };

// Usually one request. A server error gets one retry, and a refused image gets one try without it.
// Asks before every request, because the user may have opted out or removed the key since the last one.
export async function probeModel(provider: Provider, model: Model, key: string, tools: Tool[], allowed: () => boolean = () => true): Promise<ProbeResult> {
	const withImage = Boolean(model.advertisedImage ?? model.image);
	if (!allowed()) return { outcome: "cancelled", requests: 0 };
	let requests = 1;
	let result = await attempt(provider, model, key, tools, withImage);
	if (isServerProblem(result)) {
		if (!allowed()) return { outcome: "cancelled", requests };
		requests++;
		result = await attempt(provider, model, key, tools, withImage);
	}
	if (isOk(result)) return { outcome: "ok", requests };
	if (saysNothingAboutModel(result)) return { outcome: "unknown", requests };
	if (withImage && !isServerProblem(result)) {
		if (!allowed()) return { outcome: "cancelled", requests };
		requests++;
		const withoutImage = await attempt(provider, model, key, tools, false);
		if (isOk(withoutImage)) return { outcome: "ok", noImage: true, requests };
		if (saysNothingAboutModel(withoutImage)) return { outcome: "unknown", requests };
	}
	return { outcome: "failed", reason: result.reason ?? `Error ${result.status}`, requests };
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export interface ProviderCheck {
	plan: Plan;
	checked: number;
	requests: number;
	failed: { model: string; reason: string }[];
	// Several models all failed, which points at the provider being down rather than at each model.
	outage: boolean;
	// The user changed a key or a setting, so the rest of the checks were dropped.
	aborted: boolean;
}

export async function checkProvider(plan: Plan, key: string, settings: Settings, tools: Tool[], health: HealthMap, shouldContinue: () => boolean = () => true, probed = new Map<string, ProbeResult>()): Promise<ProviderCheck> {
	const { provider } = plan;
	const now = () => new Date().toISOString();
	const saved = health[provider.id] ?? {};
	const working: Record<string, ModelHealth> = { ...saved };
	const failed: { model: string; reason: string }[] = [];
	let passed = 0;
	let checked = 0;
	let requests = 0;
	let aborted = false;
	// Everything ticked is a candidate, including failing models, so they get their chance to recover.
	const candidates = buildPlan(plan, settings, undefined).selected;
	const due = candidates.filter(m => isDue(working[m.id]));
	const results = await mapLimit(due, CONCURRENT_CHECKS, async m => {
		const id = JSON.stringify([provider.id, key, m]);
		const earlier = probed.get(id);
		if (earlier) return { ...earlier, requests: 0 };
		const result = await probeModel(provider, m, key, tools, shouldContinue);
		// A model cancelled partway has had its requests for this sync, so it's left for the next one.
		if (result.outcome !== "cancelled") probed.set(id, result);
		else if (result.requests > 0) probed.set(id, { outcome: "unknown", requests: result.requests });
		return result;
	});
	due.forEach((m, i) => {
		const result = results[i] as ProbeResult;
		requests += result.requests;
		if (result.outcome === "cancelled") {
			aborted = true;
			return;
		}
		if (result.requests > 0) checked++;
		if (result.outcome === "ok") {
			passed++;
			working[m.id] = { status: "ok", checkedAt: now(), ...(result.noImage ? { noImage: true } : {}) };
		} else if (result.outcome === "failed") {
			failed.push({ model: m.id, reason: result.reason });
			working[m.id] = { status: "failed", checkedAt: now(), reason: result.reason };
		}
	});
	if (aborted) {
		health[provider.id] = working;
		return { plan, checked, requests, failed, outage: false, aborted: true };
	}
	const anyWorking = candidates.some(m => working[m.id]?.status === "ok");
	if (failed.length >= 2 && passed === 0 && !anyWorking) {
		return { plan: buildPlan(plan, settings, saved), checked, requests, failed, outage: true, aborted: false };
	}
	health[provider.id] = working;
	return { plan: buildPlan(plan, settings, working), checked, requests, failed, outage: false, aborted: false };
}
