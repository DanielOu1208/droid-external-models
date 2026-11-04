// Everything the app owns lives in one private folder: keys, settings and sync state.

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Provider } from "./providers";

export const home = () => process.env.HOME || homedir();
export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(home(), ".config"), "droid-models");
const keysPath = () => join(configDir(), "keys.json");
const settingsPath = () => join(configDir(), "settings.json");
const statePath = () => join(configDir(), "state.json");
const healthPath = () => join(configDir(), "health.json");
const secretPath = () => join(configDir(), "fixer-secret");

const LOCK_WAIT_MS = 10_000;

function ensureConfigDir() {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	chmodSync(configDir(), 0o700);
}

// A temp file of its own means two processes can't write through each other's half-finished file.
export function writeAtomic(path: string, text: string, mode: number) {
	const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, text, { mode, flag: "wx" });
		chmodSync(temp, mode);
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

function writePrivate(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (dirname(path) === configDir()) chmodSync(configDir(), 0o700);
	writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

// A lock is an exclusive SQLite transaction on an otherwise empty file. The operating system holds it,
// so it's released if a process dies, and it's never taken from an owner that's merely slow.
function takeLock(name: string, waitMs: number): (() => void) | null {
	ensureConfigDir();
	const db = new Database(join(configDir(), `${name}.lock`), { create: true });
	try {
		db.exec(`PRAGMA busy_timeout = ${waitMs}`);
		db.exec("BEGIN EXCLUSIVE");
		return () => db.close();
	} catch {
		db.close();
		return null;
	}
}

let lockDepth = 0;

// Holds across a whole read-then-write, between every process using this app. The work must be synchronous.
export function withLock<T>(run: () => T): T {
	if (lockDepth > 0) return run();
	const release = takeLock("files", LOCK_WAIT_MS);
	if (!release) throw new Error("Another copy of droid-models is busy. Try again in a moment.");
	lockDepth++;
	try {
		return run();
	} finally {
		lockDepth--;
		release();
	}
}

// For long-running work that another process shouldn't repeat. Returns a release function, or null if it's taken.
export const tryExclusive = (name: string): (() => void) | null => takeLock(name, 0);

function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	return { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) };
}

export const readKeys = (): Record<string, string> => readJson(keysPath(), {});
export const getKey = (id: string): string | undefined => readKeys()[id];
export const saveKey = (id: string, key: string) => withLock(() => writePrivate(keysPath(), { ...readKeys(), [id]: key }));

export function removeKey(id: string) {
	withLock(() => {
		const { [id]: _removed, ...rest } = readKeys();
		writePrivate(keysPath(), rest);
	});
}

export interface Settings {
	modelsDevUrl: string;
	maxOutputTokens: number;
	// Null leaves reasoning off by default.
	reasoningEffort: string | null;
	// Off unless the user opts in, because each check is a small paid request.
	healthCheck: boolean;
	// Per provider, the models the user ticked. Nothing else goes into Droid.
	selected: Record<string, string[]>;
	customProviders: Provider[];
}

export const DEFAULT_SETTINGS: Settings = {
	modelsDevUrl: "https://models.dev/api.json",
	maxOutputTokens: 32000,
	reasoningEffort: "high",
	healthCheck: false,
	selected: {},
	customProviders: [],
};

// The file as it is, for upgrading settings from an older version.
// biome-ignore lint: older versions had fields this version doesn't know.
export const readRawSettings = (): any => (existsSync(settingsPath()) ? JSON.parse(readFileSync(settingsPath(), "utf8")) : null);
export const readSettings = (): Settings => readJson(settingsPath(), DEFAULT_SETTINGS);
export const writeSettings = (settings: Settings) => withLock(() => writePrivate(settingsPath(), settings));
export const updateSettings = (change: (settings: Settings) => Settings) => withLock(() => writePrivate(settingsPath(), change(readSettings())));

export interface State {
	lastSyncAt?: string;
	rejected: string[];
	scheduleAsked: boolean;
	// Older Droid models the user chose to keep, so setup doesn't ask again.
	keptLeftovers: string[];
	healthAsked: boolean;
	// Keys a provider has rejected, as hashes, so Import doesn't keep offering them.
	rejectedImports: string[];
}

export const readState = (): State => readJson(statePath(), { rejected: [], scheduleAsked: false, keptLeftovers: [], healthAsked: false, rejectedImports: [] });
export const updateState = (change: (state: State) => State) => withLock(() => writePrivate(statePath(), change(readState())));

export interface ModelHealth {
	status: "ok" | "failed";
	checkedAt: string;
	reason?: string;
	// The model works, but the host refused an image.
	noImage?: boolean;
}

// Provider ID, then model ID.
export type HealthMap = Record<string, Record<string, ModelHealth>>;

export const readHealth = (): HealthMap => readJson(healthPath(), {});
export const writeHealth = (health: HealthMap) => withLock(() => writePrivate(healthPath(), health));

// Proves the local fixer is this user's own, because only this account can read it.
export function fixerSecret(): string {
	return withLock(() => {
		if (existsSync(secretPath())) return readFileSync(secretPath(), "utf8").trim();
		const secret = randomBytes(32).toString("hex");
		writeAtomic(secretPath(), secret, 0o600);
		return secret;
	});
}
