// Earlier versions added the newest models by themselves. Selection is now entirely the user's, so on the
// first run after upgrading, whatever is already in Droid becomes ticked, and nothing disappears.

import type { Entry } from "./catalog";
import { droidSettingsPath, isOwnedBy, readDroidSettings } from "./droid";
import { allProviders } from "./providers";
import { DEFAULT_SETTINGS, readKeys, readRawSettings, readSettings, type Settings, withLock, writeSettings } from "./store";

// Finds the provider even for a custom provider that's missing from the app's settings for now.
const providerIdIn = (helper: unknown) => (typeof helper === "string" ? /droid-models.* key (\S+?)(?: --start-fixer)?$/.exec(helper)?.[1] : undefined);

function migrated(raw: any, entries: Entry[]): Settings {
	const providers = allProviders(raw?.customProviders ?? []);
	const ticked = new Map<string, Set<string>>();
	const tick = (id: string, model: string) => ticked.set(id, (ticked.get(id) ?? new Set()).add(model));
	for (const [id, models] of Object.entries<string[]>(raw?.pinned ?? {})) {
		for (const model of models) tick(id, model);
	}
	for (const entry of entries) {
		const id = providers.find(p => isOwnedBy(entry, p))?.id ?? providerIdIn(entry.apiKeyHelper);
		if (id && typeof entry.model === "string") tick(id, entry.model);
	}
	for (const [id, models] of Object.entries<string[]>(raw?.hidden ?? {})) {
		for (const model of models) ticked.get(id)?.delete(model);
	}
	const selected = Object.fromEntries([...ticked].filter(([, models]) => models.size > 0).map(([id, models]) => [id, [...models]]));
	const { pinned: _pinned, hidden: _hidden, newestPerProvider: _newest, minContext: _context, maxOutputPrice: _price, skip: _skip, ...rest } = raw ?? {};
	return { ...DEFAULT_SETTINGS, ...rest, selected };
}

// Null while Droid's file can't be read, because without it the models the user already has would look unticked.
function planMigration(): { settings: Settings; needed: boolean } | null {
	const raw = readRawSettings();
	if (raw?.selected) return { settings: readSettings(), needed: false };
	try {
		return { settings: migrated(raw, readDroidSettings().customModels ?? []), needed: true };
	} catch {
		const firstRun = raw === null && Object.keys(readKeys()).length === 0;
		return firstRun ? { settings: DEFAULT_SETTINGS, needed: false } : null;
	}
}

// Returns false if it has to wait. Nothing may read or change selections until this succeeds.
export function migrateToSelections(): boolean {
	return withLock(() => {
		const plan = planMigration();
		if (plan?.needed) writeSettings(plan.settings);
		return plan !== null;
	});
}

// The same result without saving it, for a dry run.
export const previewMigration = () => planMigration()?.settings ?? null;

export const migrationBlocked = () => `Droid's settings file (${droidSettingsPath()}) can't be read, and this version needs it once to keep your models ticked. Nothing was changed. Fix the file and try again.`;
