import { type Entry, fetchJson, type Plan, planProvider } from "./catalog";
import { isOwnedBy, mergeEntries, readDroidSettings, writeDroidSettings } from "./droid";
import { getDroidTools } from "./droid-tools";
import { checkProvider, type ProbeResult } from "./health";
import { migrateToSelections, migrationBlocked, previewMigration } from "./migrate";
import { allProviders, type Provider } from "./providers";
import { readHealth, readKeys, readSettings, type Settings, tryExclusive, updateState, withLock, writeHealth } from "./store";

const MAX_SYNC_ATTEMPTS = 3;

let modelsDevCache: unknown = null;

export async function fetchModelsDev(settings: Settings, refresh = false) {
	if (!modelsDevCache || refresh) modelsDevCache = await fetchJson(settings.modelsDevUrl);
	return modelsDevCache;
}

export interface SyncResult {
	plans: Plan[];
	added: string[];
	removed: string[];
	total: number;
	changed: boolean;
	// Only filled in when the user has opted in to health checks.
	checked: number;
	requests: number;
	failing: { provider: string; model: string; reason: string }[];
	outages: string[];
	// Set when nothing could be written, and why.
	problem?: string;
}

interface SyncOptions {
	dryRun?: boolean;
	// A function is called for each attempt, so a restart sees any provider that just changed.
	providers?: Provider[] | (() => Provider[]);
}

const emptyResult = (problem: string, plans: Plan[] = []): SyncResult => ({ plans, added: [], removed: [], total: 0, changed: false, checked: 0, requests: 0, failing: [], outages: [], problem });

// Requests are spent even when an attempt is thrown away, so they're counted across attempts.
interface Spent {
	checked: number;
	requests: number;
}

// Returns null if the keys or settings changed along the way, so the work no longer applies.
async function attemptSync(options: SyncOptions, spent: Spent, probed: Map<string, ProbeResult>): Promise<SyncResult | null> {
	const dryRun = options.dryRun ?? false;
	if (!dryRun && !migrateToSelections()) return { ...emptyResult(migrationBlocked()), ...spent };
	const stored = readSettings();
	const settings = dryRun ? previewMigration() : stored;
	if (!settings) return { ...emptyResult(migrationBlocked()), ...spent };
	const runChecks = settings.healthCheck && !dryRun;
	// Held until the results are in Droid, so another copy can't publish models that are still being checked.
	const release = runChecks ? tryExclusive("health-check") : null;
	if (runChecks && !release) return { ...emptyResult("Another copy of droid-models is checking models, so nothing changed this time."), ...spent };
	try {
		const keys = readKeys();
		const startedWith = JSON.stringify([stored, keys]);
		const isCurrent = () => JSON.stringify([readSettings(), readKeys()]) === startedWith;
		const providers = typeof options.providers === "function" ? options.providers() : (options.providers ?? allProviders(settings.customProviders));
		const connected = providers.filter(p => keys[p.id]);
		const modelsDev = await fetchModelsDev(settings, true);
		// Without limits and prices we'd make good entries worse, so the current list stays.
		if (!modelsDev) return { ...emptyResult("models.dev is unavailable, so your models weren't changed."), ...spent };
		// Read only now that the lease is held, in case another copy just finished checking.
		const health = settings.healthCheck ? readHealth() : {};
		const plans = await Promise.all(connected.map(p => planProvider(p, keys[p.id] as string, settings, modelsDev, settings.healthCheck ? health[p.id] : undefined)));

		const failing: SyncResult["failing"] = [];
		const outages: string[] = [];
		// A dry run stays free. Everything else here only happens for users who opted in.
		if (runChecks && plans.some(p => !p.keyRejected)) {
			const tools = await getDroidTools();
			for (const [i, plan] of plans.entries()) {
				if (plan.keyRejected) continue;
				const check = await checkProvider(plan, keys[plan.provider.id] as string, settings, tools, health, isCurrent, probed);
				plans[i] = check.plan;
				spent.checked += check.checked;
				spent.requests += check.requests;
				if (check.aborted) {
					writeHealth(health);
					return null;
				}
				if (check.outage) outages.push(plan.provider.label);
				else failing.push(...check.failed.map(f => ({ provider: plan.provider.label, ...f })));
			}
			writeHealth(health);
		}

		// What the user ticked decides what's in Droid. A ticked model missing from a list stays, so a rejected key
		// or a provider outage can't remove anything. An outage found by checks adds nothing, but an unticked model still goes.
		const updates = plans.map(p => (outages.includes(p.provider.label) ? { provider: p.provider, entries: [], missing: settings.selected[p.provider.id] ?? [] } : p));
		try {
			return withLock(() => {
				if (!isCurrent()) return null;
				const droidSettings = readDroidSettings();
				const existing: Entry[] = droidSettings.customModels ?? [];
				const merged = mergeEntries(existing, updates);
				const names = (entries: Entry[]) => new Set(entries.map(e => String(e.displayName)));
				const before = names(existing);
				const after = names(merged);
				const changed = JSON.stringify(existing) !== JSON.stringify(merged);
				if (!dryRun) {
					if (changed) writeDroidSettings({ ...droidSettings, customModels: merged });
					updateState(state => ({ ...state, lastSyncAt: new Date().toISOString(), rejected: plans.filter(p => p.keyRejected).map(p => p.provider.id) }));
				}
				return {
					plans,
					added: [...after].filter(n => !before.has(n)),
					removed: [...before].filter(n => !after.has(n)),
					total: merged.length,
					changed,
					...spent,
					failing,
					outages,
				};
			});
		} catch (error) {
			return { ...emptyResult(error instanceof SyntaxError ? "Droid's settings file isn't plain JSON, so it wasn't changed." : error instanceof Error ? error.message : "Droid's models couldn't be updated.", plans), ...spent };
		}
	} finally {
		release?.();
	}
}

let queue: Promise<unknown> = Promise.resolve();

// One at a time, so a slower sync can't overwrite a newer one or pay for the same check twice.
export function runSync(options: SyncOptions = {}): Promise<SyncResult> {
	const run = queue.then(async () => {
		const spent: Spent = { checked: 0, requests: 0 };
		// A restart reuses these, so it doesn't pay to test the same model again.
		const probed = new Map<string, ProbeResult>();
		for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt++) {
			const result = await attemptSync(options, spent, probed);
			if (result) return result;
		}
		return { ...emptyResult("Your keys or settings kept changing, so Droid's models weren't updated. Try again."), ...spent };
	});
	queue = run.catch(() => undefined);
	return run;
}

export function removeFromDroid(provider: Provider) {
	withLock(() => {
		const droidSettings = readDroidSettings();
		const existing: Entry[] = droidSettings.customModels ?? [];
		const kept = existing.filter(e => !isOwnedBy(e, provider));
		if (kept.length !== existing.length) writeDroidSettings({ ...droidSettings, customModels: kept });
	});
}

export interface DroidSummary {
	counts: Record<string, number>;
	total: number;
	unreadable: boolean;
}

export function summarizeDroid(providers: Provider[]): DroidSummary {
	try {
		const entries: Entry[] = readDroidSettings().customModels ?? [];
		const counts: Record<string, number> = {};
		for (const p of providers) counts[p.id] = entries.filter(e => isOwnedBy(e, p)).length;
		return { counts, total: entries.length, unreadable: false };
	} catch {
		return { counts: {}, total: 0, unreadable: true };
	}
}
