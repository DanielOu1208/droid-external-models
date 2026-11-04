// Earlier versions added the newest models by themselves. Selection is now entirely the user's, so on the
// first run after upgrading, whatever is already in Droid becomes ticked, and nothing disappears.

import { readDroidSettings, isOwnedBy } from "./droid";
import { allProviders } from "./providers";
import { DEFAULT_SETTINGS, readRawSettings, withLock, writeSettings } from "./store";

export function migrateToSelections() {
	withLock(() => {
		const raw = readRawSettings();
		if (raw?.selected) return;
		let entries: Record<string, unknown>[];
		try {
			entries = readDroidSettings().customModels ?? [];
		} catch {
			// Droid's file can't be read right now, so this waits for a run when it can be.
			return;
		}
		const selected: Record<string, string[]> = {};
		for (const provider of allProviders(raw?.customProviders ?? [])) {
			const models = new Set<string>(raw?.pinned?.[provider.id] ?? []);
			for (const entry of entries) {
				if (isOwnedBy(entry, provider) && typeof entry.model === "string") models.add(entry.model);
			}
			for (const hidden of raw?.hidden?.[provider.id] ?? []) models.delete(hidden);
			if (models.size > 0) selected[provider.id] = [...models];
		}
		const { pinned: _pinned, hidden: _hidden, newestPerProvider: _newest, minContext: _context, maxOutputPrice: _price, skip: _skip, ...rest } = raw ?? {};
		writeSettings({ ...DEFAULT_SETTINGS, ...rest, selected });
	});
}
