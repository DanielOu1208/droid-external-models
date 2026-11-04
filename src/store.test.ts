import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, fixerSecret, readKeys, saveKey, tryExclusive, withLock } from "./store";

let dir: string;
const savedHome = process.env.HOME;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "droid-models-store-"));
	process.env.HOME = dir;
	delete process.env.XDG_CONFIG_HOME;
});
afterEach(() => {
	process.env.HOME = savedHome;
	rmSync(dir, { recursive: true, force: true });
});

describe("saving from many processes at once", () => {
	test("keeps every key, leaves a valid file, and leaves no temp files", async () => {
		const store = join(import.meta.dir, "store.ts");
		const writers = Array.from({ length: 16 }, (_, i) =>
			Bun.spawn(["bun", "-e", `import { saveKey } from ${JSON.stringify(store)}; saveKey("provider-${i}", "dummy-${i}");`], { env: { ...process.env, HOME: dir }, stdout: "ignore", stderr: "pipe" }),
		);
		const codes = await Promise.all(writers.map(w => w.exited));
		expect(codes.every(code => code === 0)).toBe(true);
		const keys = JSON.parse(readFileSync(join(configDir(), "keys.json"), "utf8"));
		expect(Object.keys(keys)).toHaveLength(16);
		expect(readdirSync(configDir()).filter(name => name.endsWith(".tmp") || name === ".lock")).toEqual([]);
		expect(statSync(join(configDir(), "keys.json")).mode & 0o777).toBe(0o600);
	}, 60_000);
});

describe("locks", () => {
	test("can nest within one process", () => {
		expect(withLock(() => withLock(() => "done"))).toBe("done");
		saveKey("a", "1");
		expect(readKeys()).toEqual({ a: "1" });
	});

	test("are released when the work throws", () => {
		expect(() => withLock(() => { throw new Error("boom"); })).toThrow("boom");
		expect(withLock(() => "free again")).toBe("free again");
	});

	test("an exclusive task can't be taken twice until it's released", () => {
		const release = tryExclusive("task");
		expect(release).not.toBeNull();
		expect(tryExclusive("task")).toBeNull();
		release?.();
		const again = tryExclusive("task");
		expect(again).not.toBeNull();
		again?.();
	});

	async function holdInAnotherProcess(name: string) {
		const store = join(import.meta.dir, "store.ts");
		const holder = Bun.spawn(["bun", "-e", `import { tryExclusive } from ${JSON.stringify(store)}; if (!tryExclusive(${JSON.stringify(name)})) process.exit(9); console.log("held"); setInterval(() => {}, 1000);`], { env: { ...process.env, HOME: dir }, stdout: "pipe", stderr: "ignore" });
		const reader = holder.stdout.getReader();
		await reader.read();
		return holder;
	}

	test("another process really is kept out, however old its lock gets", async () => {
		const holder = await holdInAnotherProcess("task");
		try {
			expect(tryExclusive("task")).toBeNull();
			const lockFile = join(configDir(), "task.lock");
			const longAgo = new Date(Date.now() - 86_400_000);
			utimesSync(lockFile, longAgo, longAgo);
			expect(tryExclusive("task")).toBeNull();
		} finally {
			holder.kill(9);
			await holder.exited;
		}
	}, 30_000);

	test("a process that dies gives its lock back", async () => {
		const holder = await holdInAnotherProcess("task");
		holder.kill(9);
		await holder.exited;
		const release = tryExclusive("task");
		expect(release).not.toBeNull();
		release?.();
	}, 30_000);
});

describe("the fixer secret", () => {
	test("stays the same, and only this account can read it", () => {
		const secret = fixerSecret();
		expect(secret).toHaveLength(64);
		expect(fixerSecret()).toBe(secret);
		expect(statSync(join(configDir(), "fixer-secret")).mode & 0o777).toBe(0o600);
	});
});
