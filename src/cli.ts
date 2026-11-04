#!/usr/bin/env bun
import pkg from "../package.json";
import { findLeftovers } from "./cleanup";
import { readDroidSettings } from "./droid";
import { FIXER_PORT, serveFixer, startFixerAndGetToken } from "./fixer";
import { migrateToSelections, migrationBlocked } from "./migrate";
import { allProviders, checkCustomProviders } from "./providers";
import { logPath, launchdScheduler } from "./schedule";
import { ensureStableCopy, stableCopyPath } from "./self";
import { getKey, readKeys, readSettings } from "./store";
import { runSync, summarizeDroid } from "./sync";

const USAGE = `droid-models ${pkg.version}: use your own model providers in Factory Droid.

  droid-models                   open the app
  droid-models status            show providers, keys and models
  droid-models sync [--dry-run]  update Droid's models now
  droid-models schedule [--remove]  sync daily in the background (macOS)
  droid-models key <provider>    print a key (Droid uses this)
`;

async function sync(dryRun: boolean) {
	console.log(new Date().toISOString());
	const result = await runSync({ dryRun });
	for (const plan of result.plans) {
		if (plan.keyRejected) {
			console.log(`\n${plan.provider.label}: the provider rejected this key, so its models weren't changed.`);
			continue;
		}
		console.log(`\n${plan.provider.label}: ${plan.selected.length} ticked, from ${plan.listed} listed (list from ${plan.listSource})`);
		if (plan.missing.length > 0) console.log(`  No longer listed, kept until you untick them: ${plan.missing.join(", ")}`);
		for (const m of plan.selected) {
			console.log(`  ${m.id.padEnd(44)} ${m.released.padEnd(11)} ${m.droidProvider}`);
		}
	}
	if (result.problem) {
		console.error(`\n${result.problem}`);
		process.exit(1);
	}
	if (result.checked > 0) {
		console.log(`\nHealth check: tested ${result.checked} models with ${result.requests} requests.`);
		for (const f of result.failing) console.log(`  ${f.provider} ${f.model}: kept out of Droid (${f.reason})`);
		for (const name of result.outages) console.log(`  ${name}: every model failed, so its models weren't changed.`);
	}
	console.log(`\nAdd ${result.added.length}, remove ${result.removed.length}, total ${result.total} custom models.`);
	console.log(dryRun ? "Dry run: nothing was written." : result.changed ? "Droid's settings were updated." : "Already up to date.");
}

function status() {
	const settings = readSettings();
	console.log(`Health check: ${settings.healthCheck ? "on" : "off"}\n`);
	const keys = readKeys();
	const providers = allProviders(settings.customProviders);
	for (const problem of checkCustomProviders(settings.customProviders).problems) console.log(`${problem}\n`);
	const summary = summarizeDroid(providers);
	const width = Math.max(...providers.map(p => p.label.length));
	for (const p of providers) {
		const state = keys[p.id] ? `key saved, ${summary.counts[p.id] ?? 0} models in Droid` : "no key";
		console.log(`${p.label.padEnd(width)}  ${state}`);
	}
	if (!summary.unreadable) {
		const others = findLeftovers(readDroidSettings(), providers, keys).length;
		if (others > 0) console.log(`\n${others} other custom models in Droid weren't added by this app. Open the app and press c to review them.`);
	}
}

function schedule(remove: boolean) {
	if (!launchdScheduler.supported) {
		console.error("Scheduling uses launchd, so it's macOS only. Elsewhere, run `droid-models sync` from cron.");
		process.exit(1);
	}
	if (remove) {
		launchdScheduler.remove();
		console.log("Daily sync removed.");
		return;
	}
	const error = launchdScheduler.install();
	if (error) {
		console.error(`Couldn't start the daily sync: ${error}`);
		process.exit(1);
	}
	console.log(`Daily sync installed. It runs at login and at 09:00, and logs to ${logPath()}`);
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	// These can save the app's path in Droid's settings or the daily sync.
	if (command === undefined || command === "sync" || command === "schedule") {
		try {
			ensureStableCopy();
		} catch (error) {
			console.error(`Couldn't copy the app to ${stableCopyPath()}: ${(error as Error).message}`);
			process.exit(1);
		}
	}
	switch (command) {
		case undefined: {
			if (!process.stdin.isTTY || !process.stdout.isTTY) {
				console.log(USAGE);
				return;
			}
			if (!migrateToSelections()) {
				console.error(migrationBlocked());
				process.exit(1);
			}
			const { startApp } = await import("./tui");
			return startApp();
		}
		case "key": {
			const key = args[0] ? getKey(args[0]) : undefined;
			if (!key) {
				console.error(`No key saved for ${args[0] ?? "that provider"}. Run droid-models to add one.`);
				process.exit(1);
			}
			if (args.includes("--start-fixer")) {
				const token = await startFixerAndGetToken();
				if (!token) {
					console.error(`Couldn't confirm that port ${FIXER_PORT} is droid-models' own local process, so this model can't connect. Something else may be using that port.`);
					process.exit(1);
				}
				process.stdout.write(token);
				return;
			}
			process.stdout.write(key);
			return;
		}
		case "fixer": {
			try {
				serveFixer(() => allProviders(readSettings().customProviders));
			} catch {
				// Another copy got there first, which is just as good.
				process.exit(0);
			}
			return;
		}
		case "sync":
			return sync(args.includes("--dry-run"));
		case "status":
			return status();
		case "schedule":
			return schedule(args.includes("--remove"));
		case "--version":
		case "-v":
			console.log(pkg.version);
			return;
		case "--help":
		case "-h":
		case "help":
			console.log(USAGE);
			return;
		default:
			console.error(USAGE);
			process.exit(1);
	}
}

await main();
