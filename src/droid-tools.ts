// Health checks send the same tool definitions Droid sends, because a model can pass a plain request
// and still reject those. Droid is asked for its list by pointing it at a throwaway local server.

import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { configDir, home } from "./store";

const MAX_AGE_MS = 24 * 3_600_000;
const cachePath = () => join(configDir(), "droid-tools.json");

// Used only if Droid can't be asked. It keeps the field that hosts have rejected before.
const FALLBACK_TOOLS = [
	{
		type: "function",
		function: {
			name: "search",
			description: "Search for something",
			parameters: { type: "object", properties: { query: { type: "string" }, limit: { anyOf: [{ type: "integer", exclusiveMinimum: 0 }, { type: "null" }] } }, required: ["query"], additionalProperties: false },
		},
	},
];

const findDroid = () => [Bun.which("droid"), "/Applications/Factory.app/Contents/Resources/bin/droid", join(home(), ".local", "bin", "droid")].find(path => path && existsSync(path));

function removeSessionFiles(workDir: string) {
	const sessions = join(home(), ".factory", "sessions");
	if (!existsSync(sessions)) return;
	for (const name of readdirSync(sessions)) {
		if (name.endsWith(basename(workDir))) rmSync(join(sessions, name), { recursive: true, force: true });
	}
}

async function captureTools(): Promise<unknown[] | null> {
	const droid = findDroid();
	if (!droid) return null;
	let captured: unknown[] | null = null;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { tools?: unknown[] };
			if (Array.isArray(body.tools)) captured ??= body.tools;
			const chunk = { id: "c", object: "chat.completion.chunk", model: "capture", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const workDir = realpathSync(mkdtempSync(join(tmpdir(), "droid-models-capture-")));
	try {
		const overlay = join(workDir, "overlay.json");
		writeFileSync(overlay, JSON.stringify({ customModels: [{ model: "capture", displayName: "Capture", provider: "generic-chat-completion-api", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "unused" }] }));
		const proc = Bun.spawn([droid, "exec", "--settings", overlay, "-m", "custom:Capture-0", "-o", "json", "Reply with only OK"], { cwd: workDir, stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 45_000 });
		await proc.exited;
		return captured;
	} catch {
		return null;
	} finally {
		server.stop(true);
		removeSessionFiles(workDir);
		rmSync(workDir, { recursive: true, force: true });
	}
}

export async function getDroidTools(): Promise<unknown[]> {
	const cached = existsSync(cachePath()) ? (JSON.parse(readFileSync(cachePath(), "utf8")) as unknown[]) : null;
	if (cached && Date.now() - statSync(cachePath()).mtimeMs < MAX_AGE_MS) return cached;
	const tools = await captureTools();
	if (tools?.length) {
		writeFileSync(cachePath(), JSON.stringify(tools), { mode: 0o600 });
		return tools;
	}
	return cached ?? FALLBACK_TOOLS;
}
