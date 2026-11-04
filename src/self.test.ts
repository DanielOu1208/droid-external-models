import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isManagedPath, refreshCopy } from "./self";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "droid-models-self-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fakeApp(name: string, version: string) {
	const path = join(dir, name);
	writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
	chmodSync(path, 0o755);
	return path;
}

describe("where the app saves its own path", () => {
	test("only an npm-installed copy counts as managed", () => {
		expect(isManagedPath("/usr/local/lib/node_modules/droid-external-models-darwin-arm64/bin/droid-models")).toBe(true);
		expect(isManagedPath("/home/me/.npm/_npx/abc123/node_modules/droid-external-models-linux-x64/bin/droid-models")).toBe(true);
		expect(isManagedPath("/home/me/.local/bin/droid-models")).toBe(false);
		expect(isManagedPath("/home/me/my_node_modules/droid-models")).toBe(false);
	});

	test("makes a runnable copy that outlives the original", () => {
		const source = fakeApp("source", "1.0.0");
		const target = join(dir, "config", "bin", "droid-models");
		refreshCopy(source, target, "1.0.0");
		rmSync(source);
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("1.0.0");
		expect(statSync(target).mode & 0o777).toBe(0o700);
		expect(readdirSync(join(dir, "config", "bin"))).toEqual(["droid-models"]);
	});

	test("leaves a current copy alone", () => {
		const target = fakeApp("target", "1.0.0");
		const before = readFileSync(target, "utf8");
		refreshCopy(fakeApp("source", "1.0.0"), target, "1.0.0");
		expect(readFileSync(target, "utf8")).toBe(before);
		expect(statSync(target).mode & 0o777).toBe(0o755);
	});

	test("replaces a copy from another version, or one that won't run", () => {
		const target = fakeApp("target", "1.0.0");
		refreshCopy(fakeApp("source", "2.0.0"), target, "2.0.0");
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("2.0.0");
		writeFileSync(target, "not a program");
		refreshCopy(fakeApp("source", "2.0.0"), target, "2.0.0");
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("2.0.0");
	});

	test("a failed copy leaves the old one in place, and no temp file", () => {
		const target = fakeApp("target", "1.0.0");
		expect(() => refreshCopy(join(dir, "missing"), target, "2.0.0")).toThrow();
		expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("1.0.0");
		expect(existsSync(`${target}.${process.pid}.tmp`)).toBe(false);
	});
});
