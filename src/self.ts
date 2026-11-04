import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import pkg from "../package.json";
import { configDir } from "./store";

// A compiled binary runs from Bun's virtual filesystem.
const compiled = import.meta.path.startsWith("/$bunfs/");

// npm can replace or delete the folder a package runs from, and npx's is only a cache.
export const isManagedPath = (path: string) => path.split(sep).includes("node_modules");
const managed = compiled && isManagedPath(process.execPath);

export const stableCopyPath = () => join(configDir(), "bin", "droid-models");

export function selfArgs(): string[] {
	if (!compiled) return [process.execPath, join(import.meta.dir, "cli.ts")];
	return [managed ? stableCopyPath() : process.execPath];
}

function runsVersion(path: string, version: string) {
	if (!existsSync(path)) return false;
	try {
		return Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim() === version;
	} catch {
		return false;
	}
}

export function refreshCopy(source: string, target: string, version: string) {
	if (runsVersion(target, version)) return;
	mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	const temp = `${target}.${process.pid}.tmp`;
	try {
		copyFileSync(source, temp);
		chmodSync(temp, 0o700);
		// Renamed into place because macOS kills a signed binary that's overwritten in place.
		renameSync(temp, target);
	} finally {
		rmSync(temp, { force: true });
	}
}

// Droid's settings and the daily sync save a path to this app, so an npm install saves its own copy's path.
export const ensureStableCopy = () => {
	if (managed) refreshCopy(process.execPath, stableCopyPath(), pkg.version);
};

const shellQuote = (arg: string) => (/^[\w./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

// The command Droid runs to get a provider's key.
export const helperCommand = (providerId: string, startFixer = false) => [...selfArgs(), "key", providerId, ...(startFixer ? ["--start-fixer"] : [])].map(shellQuote).join(" ");
