import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLeftovers, finishCleanup, selectModels } from "./cleanup";
import { migrateToSelections, previewMigration } from "./migrate";
import type { Provider } from "./providers";
import { configDir, readSettings, saveKey, updateSettings } from "./store";
import { runSync } from "./sync";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
const savedHome = process.env.HOME;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "droid-models-migrate-"));
	process.env.HOME = dir;
	delete process.env.XDG_CONFIG_HOME;
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			return path === "/md" ? Response.json({}) : Response.json({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] });
		},
	});
});
afterEach(() => {
	server.stop(true);
	process.env.HOME = savedHome;
	rmSync(dir, { recursive: true, force: true });
});

const provider = (id = "host"): Provider => ({ id, label: id, envNames: ["X"], droidProvider: "generic-chat-completion-api", baseUrl: `http://localhost:${server.port}`, listUrl: `http://localhost:${server.port}/models` });
const owned = (model: string, id = "host") => ({ model, displayName: `${model} [${id}]`, apiKeyHelper: `/x/droid-models key ${id}` });
const droidFile = () => join(dir, ".factory", "settings.json");
const settingsFile = () => join(configDir(), "settings.json");
function writeDroid(content: string) {
	mkdirSync(join(dir, ".factory"), { recursive: true });
	writeFileSync(droidFile(), content);
}
const seedDroid = (entries: unknown[]) => writeDroid(JSON.stringify({ customModels: entries }));
const droidModels = () => (JSON.parse(readFileSync(droidFile(), "utf8")).customModels as { model: string }[]).map(e => e.model).sort();
function writeOldSettings(extra: object = {}) {
	mkdirSync(configDir(), { recursive: true });
	writeFileSync(settingsFile(), JSON.stringify({ modelsDevUrl: `http://localhost:${server.port}/md`, newestPerProvider: 6, ...extra }));
}
const providers = () => [provider()];

describe("moving to ticked models", () => {
	test("everything already in Droid becomes ticked, except what the user hid", () => {
		writeOldSettings({ pinned: { host: ["pinned"] }, hidden: { host: ["hidden"] } });
		seedDroid([owned("a"), owned("hidden"), { model: "mine", displayName: "Mine" }]);
		expect(migrateToSelections()).toBe(true);
		const raw = JSON.parse(readFileSync(settingsFile(), "utf8"));
		expect(raw.selected.host.sort()).toEqual(["a", "pinned"]);
		expect(raw.newestPerProvider).toBeUndefined();
		expect(raw.pinned).toBeUndefined();
	});

	test("waits while Droid's file can't be read, then keeps everything", async () => {
		writeOldSettings();
		saveKey("host", "k");
		writeDroid("{ not json");
		const before = readFileSync(settingsFile(), "utf8");
		expect(migrateToSelections()).toBe(false);
		const blocked = await runSync({ providers });
		expect(blocked.problem).toContain("can't be read");
		expect(readFileSync(settingsFile(), "utf8")).toBe(before);
		expect(readFileSync(droidFile(), "utf8")).toBe("{ not json");

		seedDroid([owned("a"), owned("b")]);
		const result = await runSync({ providers });
		expect(result.problem).toBeUndefined();
		expect(droidModels()).toEqual(["a", "b"]);
		expect(readSettings().selected.host?.sort()).toEqual(["a", "b"]);
	});

	test("also waits for someone who never changed a setting, since they can have models in Droid", () => {
		saveKey("host", "k");
		writeDroid("{ not json");
		expect(migrateToSelections()).toBe(false);
	});

	test("a first run isn't blocked by an unreadable Droid file, and writes nothing", () => {
		writeDroid("{ not json");
		expect(migrateToSelections()).toBe(true);
		expect(() => readFileSync(settingsFile())).toThrow();
	});

	test("keeps picks and models of a custom provider that's missing right now", async () => {
		const away = provider("away");
		writeOldSettings({ pinned: { away: ["pinned"] } });
		saveKey("away", "k");
		seedDroid([owned("a", "away"), owned("pinned", "away")]);
		expect(migrateToSelections()).toBe(true);
		expect(readSettings().selected.away?.sort()).toEqual(["a", "pinned"]);
		await runSync({ providers: [away] });
		expect(droidModels()).toEqual(["a", "pinned"]);
	});

	test("a dry run previews the move without saving anything", async () => {
		writeOldSettings();
		saveKey("host", "k");
		seedDroid([owned("a"), owned("b")]);
		const settingsBefore = readFileSync(settingsFile(), "utf8");
		const droidBefore = readFileSync(droidFile(), "utf8");
		expect(previewMigration()?.selected.host?.sort()).toEqual(["a", "b"]);
		const result = await runSync({ dryRun: true, providers });
		expect(result.problem).toBeUndefined();
		expect(result.plans[0]?.selected.map(m => m.id).sort()).toEqual(["a", "b"]);
		expect(result.removed).toEqual([]);
		expect(readFileSync(settingsFile(), "utf8")).toBe(settingsBefore);
		expect(readFileSync(droidFile(), "utf8")).toBe(droidBefore);
	});

	test("once it's done, a later empty selection is respected", async () => {
		writeOldSettings();
		saveKey("host", "k");
		seedDroid([owned("a")]);
		await runSync({ providers });
		updateSettings(s => ({ ...s, selected: {} }));
		await runSync({ providers });
		expect(droidModels()).toEqual([]);
	});
});

describe("a cleanup that can't move a model", () => {
	const handMade = { model: "a", displayName: "My A", baseUrl: "https://host.example/v1", apiKey: "pasted" };
	const host: Provider = { id: "host", label: "Host", envNames: ["X"], droidProvider: "generic-chat-completion-api", baseUrl: "https://host.example/v1" };
	const keys = { host: "pasted" };

	test("keeps a tick from before the cleanup", () => {
		saveKey("host", "pasted");
		updateSettings(s => ({ ...s, selected: { host: ["a"] } }));
		seedDroid([handMade]);
		const chosen = findLeftovers(JSON.parse(readFileSync(droidFile(), "utf8")), [host], keys);
		expect(chosen[0]?.kind).toBe("sameProvider");
		const newTicks = selectModels(chosen);
		expect(newTicks).toEqual([]);
		const result = finishCleanup(chosen, [host], keys, newTicks);
		expect(result.removed).toEqual([]);
		expect(readSettings().selected.host).toEqual(["a"]);
		expect(droidModels()).toEqual(["a"]);
	});

	test("takes back a tick it added", () => {
		saveKey("host", "pasted");
		seedDroid([handMade]);
		const chosen = findLeftovers(JSON.parse(readFileSync(droidFile(), "utf8")), [host], keys);
		const newTicks = selectModels(chosen);
		expect(newTicks).toEqual([{ providerId: "host", model: "a" }]);
		expect(readSettings().selected.host).toEqual(["a"]);
		finishCleanup(chosen, [host], keys, newTicks);
		expect(readSettings().selected.host).toEqual([]);
	});
});
