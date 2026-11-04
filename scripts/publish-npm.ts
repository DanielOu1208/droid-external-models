#!/usr/bin/env bun
// Publishes a release's binaries to npm: one package per platform, then the main package that picks the right one.
// Usage: bun scripts/publish-npm.ts <folder with droid-models-<platform>.tar.gz> [--dry-run]

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";

const PLATFORMS = [
	{ id: "darwin-arm64", os: "darwin", cpu: "arm64", label: "macOS on Apple Silicon" },
	{ id: "darwin-x64", os: "darwin", cpu: "x64", label: "macOS on Intel" },
	{ id: "linux-arm64", os: "linux", cpu: "arm64", label: "Linux on ARM" },
	{ id: "linux-x64", os: "linux", cpu: "x64", label: "Linux on x64" },
];

const assets = process.argv[2] && resolve(process.argv[2]);
const dryRun = process.argv.includes("--dry-run");
if (!assets) {
	console.error("Usage: bun scripts/publish-npm.ts <folder with droid-models-<platform>.tar.gz> [--dry-run]");
	process.exit(2);
}

const root = resolve(import.meta.dir, "..");
const shared = { version: pkg.version, license: pkg.license, repository: pkg.repository, homepage: pkg.homepage, bugs: pkg.bugs };
const stage = mkdtempSync(join(tmpdir(), "droid-models-npm-"));

function run(command: string[]) {
	const result = Bun.spawnSync(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	if (result.exitCode !== 0) throw new Error(`Failed: ${command.join(" ")}`);
}

function stagePlatform(platform: (typeof PLATFORMS)[number]) {
	const archive = join(assets as string, `droid-models-${platform.id}.tar.gz`);
	if (!existsSync(archive)) throw new Error(`Missing ${archive}`);
	const name = `${pkg.name}-${platform.id}`;
	const dir = join(stage, name);
	mkdirSync(join(dir, "bin"), { recursive: true });
	run(["tar", "-xzf", archive, "-C", join(dir, "bin"), "droid-models"]);
	chmodSync(join(dir, "bin", "droid-models"), 0o755);
	copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
	writeFileSync(join(dir, "README.md"), `The droid-models app for ${platform.label}. Install [${pkg.name}](https://www.npmjs.com/package/${pkg.name}) instead of this.\n`);
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify(
			{
				name,
				...shared,
				description: `The droid-models app for ${platform.label}.`,
				os: [platform.os],
				cpu: [platform.cpu],
				...(platform.os === "linux" ? { libc: ["glibc"] } : {}),
				files: ["bin"],
				preferUnplugged: true,
			},
			null,
			2,
		)}\n`,
	);
	return dir;
}

function stageMain() {
	const dir = join(stage, pkg.name);
	mkdirSync(join(dir, "bin"), { recursive: true });
	copyFileSync(join(root, "npm", "droid-models.cjs"), join(dir, "bin", "droid-models.cjs"));
	chmodSync(join(dir, "bin", "droid-models.cjs"), 0o755);
	for (const file of ["LICENSE", "README.md"]) copyFileSync(join(root, file), join(dir, file));
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify(
			{
				name: pkg.name,
				...shared,
				description: pkg.description,
				keywords: ["factory", "droid", "byok", "custom-models", "openrouter", "cli"],
				bin: { "droid-models": "bin/droid-models.cjs" },
				files: ["bin", "README.md", "LICENSE"],
				optionalDependencies: Object.fromEntries(PLATFORMS.map(p => [`${pkg.name}-${p.id}`, pkg.version])),
			},
			null,
			2,
		)}\n`,
	);
	return dir;
}

const sha256 = async (path: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");

// A rerun finishes a partly published release. Anything else under this name and version must not go out as a dependency.
async function assertMatchesRelease(dir: string, name: string, program: string) {
	const download = mkdtempSync(join(stage, "published-"));
	run(["npm", "pack", `${name}@${pkg.version}`, "--pack-destination", download, "--silent"]);
	const archive = new Bun.Glob("*.tgz").scanSync(download).next().value;
	run(["tar", "-xzf", join(download, archive), "-C", download]);
	const published = await Bun.file(join(download, "package", "package.json")).json();
	if (published.scripts?.preinstall || published.scripts?.install || published.scripts?.postinstall || (await sha256(join(download, "package", program))) !== (await sha256(join(dir, program)))) {
		throw new Error(`${name}@${pkg.version} is on npm but isn't this release, so nothing more was published. Check who owns that package.`);
	}
}

async function publish(dir: string, name: string, program: string) {
	const existing = Bun.spawnSync(["npm", "view", `${name}@${pkg.version}`, "version"], { stdout: "pipe", stderr: "ignore" });
	if (existing.stdout.toString().trim() === pkg.version) {
		await assertMatchesRelease(dir, name, program);
		console.log(`${name}@${pkg.version} is already published.`);
		return;
	}
	// Provenance links a package to the workflow run that built it, so it only works from GitHub Actions.
	run(["npm", "publish", dir, "--access", "public", ...(process.env.GITHUB_ACTIONS ? ["--provenance"] : []), ...(dryRun ? ["--dry-run"] : [])]);
}

try {
	// The main package goes last, so it's never live without the packages it needs.
	for (const platform of PLATFORMS) await publish(stagePlatform(platform), `${pkg.name}-${platform.id}`, "bin/droid-models");
	await publish(stageMain(), pkg.name, "bin/droid-models.cjs");
} finally {
	rmSync(stage, { recursive: true, force: true });
}
