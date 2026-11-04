// Finds models that were already in Droid before this app, so setup can clear up any overlap.

import { chmodSync, copyFileSync } from "node:fs";
import type { Entry } from "./catalog";
import { droidSettingsPath, isOwnedBy, readDroidSettings, writeDroidSettings } from "./droid";
import { realBaseUrl } from "./fixer";
import type { Provider } from "./providers";
import { updateSettings, withLock } from "./store";
import { sameEndpoint } from "./urls";

// "similar" is the same model on the same endpoint, but set up differently, so it isn't a true duplicate.
export type LeftoverKind = "duplicate" | "similar" | "sameProvider" | "other";

export interface Leftover {
	entry: Entry;
	kind: LeftoverKind;
	// The app's own entry for the same model on the same endpoint.
	replacement?: Entry;
	// The connected provider this entry's endpoint belongs to.
	provider?: Provider;
	// A provider in this app that also offers this model, on a different endpoint.
	alsoVia?: string;
	// What would be lost by replacing this entry with the app's own.
	differences: string[];
	// Droid settings that point at this entry.
	usedBy: string[];
	removable: boolean;
}

const SETTING_LABELS: Record<string, string> = {
	"sessionDefaultSettings.model": "your default model",
	"sessionDefaultSettings.specModeModel": "spec mode",
	"missionModelSettings.workerModel": "mission workers",
	"missionModelSettings.validatorModel": "mission validators",
};

// These don't change how a model behaves, or are covered by comparing the key itself.
const NEUTRAL_FIELDS = new Set(["model", "displayName", "baseUrl", "apiKey", "id", "index"]);

const FIELD_LABELS: Record<string, string> = {
	apiKeyHelper: "key helper",
	apiKeyHelperTtlMs: "key helper",
	provider: "protocol",
	extraHeaders: "custom headers",
	extraArgs: "custom parameters",
	bedrock: "AWS settings",
	authMode: "auth mode",
	maxOutputTokens: "output limit",
	maxContextLimit: "context limit",
	noImageSupport: "image support",
	reasoningEffort: "reasoning",
	enableThinking: "thinking",
	thinkingMaxTokens: "thinking limit",
};

const shortName = (model: unknown) => String(model).split("/").pop()?.toLowerCase();
const slug = (entry: Entry) => String(entry.displayName).replace(/\s+/g, "-");

// Two entries can share a model and address but use different keys, so the whole entry identifies it.
// Droid renumbers "id" and "index", so they don't count. It's a hash, because entries can hold keys.
export function fingerprint(leftover: Leftover): string {
	const { id: _id, index: _index, ...rest } = leftover.entry;
	return new Bun.CryptoHasher("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 24);
}

// Ticked by default only when removing it can't lose anything.
export const isPreTicked = (leftover: Leftover) => (leftover.kind === "duplicate" || leftover.kind === "sameProvider") && leftover.differences.length === 0;

// The ID Droid uses for a custom model. Its trailing number doesn't affect which model it finds.
export const modelRef = (entry: Entry) => (typeof entry.id === "string" && entry.id.startsWith("custom:") ? entry.id : `custom:${slug(entry)}-0`);

function usesKey(entry: Entry, key: string | undefined) {
	if (!key || typeof entry.apiKey !== "string") return false;
	const variable = entry.apiKey.match(/^\$\{(\w+)\}$/)?.[1];
	return variable ? process.env[variable] === key : entry.apiKey === key;
}

// What would be lost by replacing this entry with the app's own. With no replacement yet there's nothing
// to compare against, so anything the entry sets for itself counts.
function findDifferences(entry: Entry, provider: Provider, key: string | undefined, replacement?: Entry): string[] {
	const differences: string[] = [];
	for (const [field, value] of Object.entries(entry)) {
		if (NEUTRAL_FIELDS.has(field) || value === undefined) continue;
		if (field === "provider" && !replacement && (!provider.droidProvider || value === provider.droidProvider)) continue;
		if (replacement && JSON.stringify(value) === JSON.stringify(field === "provider" ? (replacement.provider ?? provider.droidProvider) : replacement[field])) continue;
		differences.push(FIELD_LABELS[field] ?? field);
	}
	// A helper takes priority over a saved key, and it can't be compared without running it.
	if (!entry.apiKeyHelper && !usesKey(entry, key)) differences.push("key");
	return [...new Set(differences)];
}

function refersTo(value: string, entry: Entry) {
	if (value === entry.id || value === `custom:${entry.model}`) return true;
	return value.replace(/^custom:/, "").replace(/-\d+$/, "") === slug(entry);
}

interface CustomRef {
	path: string;
	value: string;
}

function customRefs(settings: Entry): CustomRef[] {
	const refs: CustomRef[] = [];
	const walk = (node: unknown, path: string) => {
		if (typeof node === "string") {
			if (/^custom:\S+$/.test(node)) refs.push({ path, value: node });
		} else if (Array.isArray(node)) {
			node.forEach((item, i) => walk(item, `${path}[${i}]`));
		} else if (node && typeof node === "object") {
			for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key);
		}
	};
	const { customModels: _models, ...rest } = settings;
	walk(rest, "");
	return refs;
}

const labelFor = (path: string) => SETTING_LABELS[path] ?? path;

function replaceRefs(node: unknown, entry: Entry, next: string): unknown {
	if (typeof node === "string") return /^custom:\S+$/.test(node) && refersTo(node, entry) ? next : node;
	if (Array.isArray(node)) return node.map(item => replaceRefs(item, entry, next));
	if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, replaceRefs(value, entry, next)]));
	return node;
}

export function findLeftovers(settings: Entry, providers: Provider[], keys: Record<string, string>): Leftover[] {
	const entries: Entry[] = settings.customModels ?? [];
	const isAppEntry = (e: Entry) => providers.some(p => isOwnedBy(e, p));
	const appEntries = entries.filter(isAppEntry);
	const refs = customRefs(settings);
	const endpoint = (e: Entry) => realBaseUrl(e.baseUrl, providers);
	return entries
		.filter(e => !isAppEntry(e))
		.map(entry => {
			const replacement = appEntries.find(a => a.model === entry.model && sameEndpoint(endpoint(a), entry.baseUrl));
			const provider = providers.find(p => keys[p.id] && (sameEndpoint(p.baseUrl, entry.baseUrl) || appEntries.some(a => isOwnedBy(a, p) && sameEndpoint(endpoint(a), entry.baseUrl))));
			const differences = provider ? findDifferences(entry, provider, keys[provider.id], replacement) : [];
			const kind: LeftoverKind = replacement ? (differences.length === 0 ? "duplicate" : "similar") : provider ? "sameProvider" : "other";
			const elsewhere = appEntries.find(a => shortName(a.model) === shortName(entry.model));
			const usedBy = refs.filter(r => refersTo(r.value, entry)).map(r => labelFor(r.path));
			return {
				entry,
				kind,
				replacement,
				provider,
				alsoVia: kind === "other" && elsewhere ? providers.find(p => isOwnedBy(elsewhere, p))?.label : undefined,
				differences,
				usedBy,
				// Something that depends on it needs a replacement to move to.
				removable: kind !== "other" || usedBy.length === 0,
			};
		});
}

// Settings pointing at a custom model that isn't in Droid anymore.
export function findStaleRefs(settings: Entry): { setting: string; value: string }[] {
	const entries: Entry[] = settings.customModels ?? [];
	return customRefs(settings)
		.filter(r => !entries.some(e => refersTo(r.value, e)))
		.map(r => ({ setting: labelFor(r.path), value: r.value }));
}

// Removes the chosen entries and points settings at their replacements.
export function removeEntries(settings: Entry, chosen: Leftover[]): Entry {
	const gone = new Set(chosen.map(l => l.entry));
	let next: Entry = { ...settings };
	for (const { entry, replacement } of chosen) {
		if (!replacement) continue;
		const { customModels, ...rest } = next;
		next = { ...(replaceRefs(rest, entry, modelRef(replacement)) as Entry), customModels };
	}
	const kept = (next.customModels as Entry[]).filter(e => !gone.has(e));
	// Droid numbers the entries it saved, so those numbers need to follow the new positions.
	return { ...next, customModels: kept.map((e, i) => ("index" in e ? { ...e, index: i } : e)) };
}

export function selectModels(chosen: Leftover[]) {
	updateSettings(settings => {
		const selected = { ...settings.selected };
		for (const { kind, provider, entry } of chosen) {
			if (kind !== "sameProvider" || !provider) continue;
			selected[provider.id] = [...new Set([...(selected[provider.id] ?? []), String(entry.model)])];
		}
		return { ...settings, selected };
	});
}

export interface CleanupResult {
	removed: string[];
	kept: string[];
	backup?: string;
}

// Call after pinning and syncing: anything that moved now has a replacement, so nothing is left without one.
export function finishCleanup(chosen: Leftover[], providers: Provider[], keys: Record<string, string>): CleanupResult {
	return withLock(() => {
		const settings = readDroidSettings();
		const fresh = findLeftovers(settings, providers, keys);
		const wanted = new Set(chosen.map(fingerprint));
		const matching = fresh.filter(l => wanted.has(fingerprint(l)));
		// The user saw any differences and ticked it anyway, so "similar" counts here.
		const removable = matching.filter(l => l.kind === "duplicate" || l.kind === "similar" || (l.kind === "other" && l.removable));
		const notMoved = matching.filter(l => !removable.includes(l));
		// The provider doesn't list these, so ticking them was no use. The hand-made entry stays as it was.
		updateSettings(current => {
			const selected = { ...current.selected };
			for (const { provider, entry } of notMoved) {
				if (provider) selected[provider.id] = (selected[provider.id] ?? []).filter(m => m !== entry.model);
			}
			return { ...current, selected };
		});
		const kept = notMoved.map(l => String(l.entry.displayName));
		if (removable.length === 0) return { removed: [], kept };
		const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
		const backup = `${droidSettingsPath()}.before-cleanup-${stamp}`;
		copyFileSync(droidSettingsPath(), backup);
		chmodSync(backup, 0o600);
		writeDroidSettings(removeEntries(settings, removable));
		return { removed: removable.map(l => String(l.entry.displayName)), kept, backup };
	});
}
