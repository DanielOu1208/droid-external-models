// Reads and writes the custom models in Droid's own settings file.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Entry } from "./catalog";
import type { Provider } from "./providers";
import { helperCommand } from "./self";
import { home, writeAtomic } from "./store";

export const droidSettingsPath = () => join(home(), ".factory", "settings.json");

export function readDroidSettings(): Entry {
	const path = droidSettingsPath();
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

export function writeDroidSettings(settings: Entry) {
	const path = droidSettingsPath();
	mkdirSync(dirname(path), { recursive: true });
	const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
	if (existsSync(path)) copyFileSync(path, `${path}.droid-models.bak`);
	writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`, mode);
}

// Earlier versions got keys from OMP, so those entries are ours to replace too.
const isLegacyEntry = (helper: string, entry: Entry, provider: Provider) =>
	/\/omp token \S+$/.test(helper) && String(entry.displayName).endsWith(` [${provider.label}]`);

// True for entries this app wrote for a provider. Hand-made entries never match.
export function isOwnedBy(entry: Entry, provider: Provider): boolean {
	const helper = entry.apiKeyHelper;
	if (typeof helper !== "string") return false;
	// The second check still recognizes entries after the app has moved. The first covers a copy with any other name.
	const isCurrentCommand = helper === helperCommand(provider.id) || helper === helperCommand(provider.id, true);
	const isOurs = helper.includes("droid-models") && (helper.endsWith(` key ${provider.id}`) || helper.endsWith(` key ${provider.id} --start-fixer`));
	return isCurrentCommand || isOurs || isLegacyEntry(helper, entry, provider);
}

export function mergeEntries(existing: Entry[], updates: { provider: Provider; entries: Entry[]; missing?: string[] }[]): Entry[] {
	const kept: Entry[] = [];
	for (const entry of existing) {
		const update = updates.find(({ provider }) => isOwnedBy(entry, provider));
		if (!update) kept.push(entry);
		// A model kept as it is still needs the app's current path, in case the app has moved.
		else if (update.missing?.includes(entry.model)) kept.push({ ...entry, apiKeyHelper: helperCommand(update.provider.id, String(entry.apiKeyHelper).endsWith(" --start-fixer")) });
	}
	return [...kept, ...updates.flatMap(u => u.entries)];
}
