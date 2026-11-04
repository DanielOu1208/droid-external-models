#!/usr/bin/env node
// Runs the prebuilt app that npm installed for this computer.
const { spawnSync } = require("node:child_process");

const name = `droid-external-models-${process.platform}-${process.arch}`;
let binary;
try {
	// Node also searches parent folders, which could hold another release.
	if (require(`${name}/package.json`).version !== require("../package.json").version) throw new Error("wrong version");
	binary = require.resolve(`${name}/bin/droid-models`);
} catch {
	console.error(`droid-models has no build installed for ${process.platform} ${process.arch}. It runs on macOS and on Linux with glibc, on Intel or ARM. If that's this computer, reinstall without skipping optional dependencies.`);
	process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
	console.error(`Couldn't start droid-models: ${result.error.message}`);
	process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
