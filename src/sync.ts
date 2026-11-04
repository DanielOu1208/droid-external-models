import { type Entry, fetchJson, type Plan, planProvider } from "./catalog";
import { isOwnedBy, mergeEntries, readDroidSettings, writeDroidSettings } from "./droid";
import { getDroidTools } from "./droid-tools";
import { checkProvider } from "./health";
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

// An empty result only replaces what's there if the user unticked something the provider really lists.
const userEmptiedIt = (plan: Plan, settings: Settings) => plan.available.some(m => settings.hidden[plan.provider.id]?.includes(m.id));

// Requests are spent even when an attempt is thrown away, so they're counted across attempts.
interface Spent {
	checked: number;
	requests: number;
}

// Returns null if the keys or settings changed along the way, so the work no longer applies.
async function attemptSync(options: SyncOptions, spent: Spent, checksUsed: Map<string, number>): Promise<SyncResult | null> {
	const dryRun = options.dryRun ?? false;
	const settings = readSettings();
	const runChecks = settings.healthCheck && !dryRun;
	// Held until the results are in Droid, so another copy can't publish models that are still being checked.
	const release = runChecks ? tryExclusive("health-check") : null;
	if (runChecks && !release) return { ...emptyResult("Another copy of droid-models is checking models, so nothing changed this time."), ...spent };
	try {
		const keys = readKeys();
		const startedWith = JSON.stringify([settings, keys]);
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
				// A restart continues the same sync, so it shares the same limit on checks.
				const used = checksUsed.get(plan.provider.id) ?? 0;
				const check = await checkProvider(plan, keys[plan.provider.id] as string, settings, tools, health, isCurrent, settings.newestPerProvider * 3 - used);
				checksUsed.set(plan.provider.id, used + check.checked);
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

		const updates = plans.filter(p => !p.keyRejected && !outages.includes(p.provider.label) && (p.entries.length > 0 || userEmptiedIt(p, settings)));
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
		const checksUsed = new Map<string, number>();
		for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt++) {
			const result = await attemptSync(options, spent, checksUsed);
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
