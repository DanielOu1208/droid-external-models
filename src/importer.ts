// Optional convenience: offers keys already on this computer, so nobody has to paste them twice.
// Nothing is copied until the user confirms, and the app never depends on these locations.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry } from "./catalog";
import type { Provider } from "./providers";
import { home } from "./store";
import { sameEndpoint } from "./urls";

export interface FoundKey {
	provider: Provider;
	envName?: string;
	source: string;
	key: string;
}

// Identifies a rejected key without keeping the key itself.
export const importFingerprint = (found: FoundKey) => `${found.provider.id}:${new Bun.CryptoHasher("sha256").update(found.key).digest("hex").slice(0, 16)}`;

function parseEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	const values: Record<string, string> = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
		if (!match?.[1]) continue;
		const value = (match[2] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
		if (value) values[match[1]] = value;
	}
	return values;
}

export function findKeys(providers: Provider[], stored: Record<string, string>, droidEntries: Entry[] = []): FoundKey[] {
	const sources: [string, Record<string, string | undefined>][] = [
		["shell environment", process.env],
		["~/.hermes/.env", parseEnvFile(join(home(), ".hermes", ".env"))],
		["~/.omp/agent/.env", parseEnvFile(join(home(), ".omp", "agent", ".env"))],
	];
	const found: FoundKey[] = [];
	for (const provider of providers) {
		if (stored[provider.id]) continue;
		// A key Droid is already using is the likeliest to still work.
		const pasted = droidEntries.find(e => provider.baseUrl && sameEndpoint(e.baseUrl, provider.baseUrl) && typeof e.apiKey === "string" && e.apiKey && !e.apiKey.startsWith("${"));
		if (pasted) {
			found.push({ provider, source: "Droid's custom models", key: pasted.apiKey });
			continue;
		}
		search: for (const [source, values] of sources) {
			for (const envName of provider.envNames) {
				const key = values[envName];
				if (key) {
					found.push({ provider, envName, source, key });
					break search;
				}
			}
		}
	}
	return found;
}
