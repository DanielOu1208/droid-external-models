#!/usr/bin/env bun
// Starts a built binary with an empty home folder, in a real terminal. This catches what the tests can't see,
// such as files missing from the bundle or a binary the system refuses to run.
// Usage: bun scripts/smoke.ts <binary>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";

const binary = process.argv[2] && resolve(process.argv[2]);
if (!binary) {
	console.error("Usage: bun scripts/smoke.ts <binary>");
	process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "droid-models-smoke-"));
const env = { HOME: home, PATH: process.env.PATH ?? "", TERM: "xterm-256color" };

function fail(message: string): never {
	console.error(`Smoke test failed: ${message}`);
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}

const version = Bun.spawnSync([binary, "--version"], { env });
if (version.stdout.toString().trim() !== pkg.version) fail(`--version printed "${version.stdout}", expected ${pkg.version}. ${version.stderr}`);

const status = Bun.spawnSync([binary, "status"], { env });
if (status.exitCode !== 0 || !status.stdout.toString().includes("OpenRouter")) fail(`status exited ${status.exitCode}. ${status.stdout}${status.stderr}`);

let screen = "";
const decoder = new TextDecoder();
const app = Bun.spawn([binary], {
	env,
	terminal: {
		cols: 120,
		rows: 40,
		data(_terminal, data) {
			screen += decoder.decode(data, { stream: true });
		},
	},
});

async function waitFor(check: () => boolean, ms: number) {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await Bun.sleep(100);
	return check();
}

if (!(await waitFor(() => screen.includes("OpenRouter"), 20000))) {
	app.kill();
	fail(`the app never drew its provider list. It showed: ${JSON.stringify(screen.slice(-500))}`);
}
app.terminal?.write("q");
let exited = false;
void app.exited.then(() => {
	exited = true;
});
if (!(await waitFor(() => exited, 5000))) {
	app.kill();
	fail("the app didn't quit after pressing q.");
}
if (app.exitCode !== 0) fail(`the app exited ${app.exitCode}.`);

rmSync(home, { recursive: true, force: true });
console.log(`Smoke test passed: ${pkg.version} on ${process.platform} ${process.arch}.`);
// On Linux the closed terminal would otherwise keep this script running.
process.exit(0);
