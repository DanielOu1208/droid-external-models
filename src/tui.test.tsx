import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type { Provider } from "./providers";
import type { Scheduler } from "./schedule";
import { DEFAULT_SETTINGS, getKey, readHealth, readKeys, readSettings, readState, saveKey, updateSettings, writeHealth, writeSettings } from "./store";
import { App } from "./tui";

const GOOD_KEY = "sk-test-good-key-1234";
const ENTER = "\r";
const DOWN = "\u001B[B";
const ESC = "\u001B";
let modelRequests: string[] = [];

let server: ReturnType<typeof Bun.serve>;
let dir: string;
const savedEnv = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/models-dev") {
				const models = Object.fromEntries(["alpha", "beta", "gamma"].map((id, i) => [id, { name: id.toUpperCase(), tool_call: true, limit: { context: 200000, output: 8000 }, cost: { output: 1 }, release_date: `2026-0${3 - i}-01` }]));
				return Response.json({ mock: { models } });
			}
			if (req.headers.get("authorization") !== `Bearer ${GOOD_KEY}`) return new Response("nope", { status: 401 });
			if (path === "/chat/completions") {
				const body = await req.json();
				modelRequests.push(body.model);
				return body.model === "alpha" ? Response.json({ error: { message: "Model is retired" } }, { status: 400 }) : Response.json({ choices: [] });
			}
			return Response.json({ data: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] });
		},
	});
});

afterAll(() => server.stop(true));

const provider = (): Provider => ({
	id: "mock",
	label: "Mock Cloud",
	keyUrl: "https://mock.example/keys",
	envNames: ["MOCK_API_KEY"],
	modelsDevKey: "mock",
	listUrl: `http://localhost:${server.port}/models`,
	droidProvider: "generic-chat-completion-api",
	baseUrl: `http://localhost:${server.port}`,
});

function fakeScheduler(): Scheduler & { calls: string[] } {
	let on = false;
	const calls: string[] = [];
	return {
		calls,
		supported: true,
		installed: () => on,
		install() {
			calls.push("install");
			on = true;
			return null;
		},
		remove() {
			calls.push("remove");
			on = false;
		},
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "droid-models-tui-"));
	process.env.HOME = dir;
	delete process.env.XDG_CONFIG_HOME;
	modelRequests = [];
	writeSettings({ ...DEFAULT_SETTINGS, modelsDevUrl: `http://localhost:${server.port}/models-dev` });
});

afterEach(() => {
	process.env.HOME = savedEnv.HOME;
	if (savedEnv.XDG) process.env.XDG_CONFIG_HOME = savedEnv.XDG;
	rmSync(dir, { recursive: true, force: true });
});

const droidModels = () => {
	const path = join(dir, ".factory", "settings.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).customModels ?? [] : [];
};

function startApp(scheduler = fakeScheduler()) {
	const opened: string[] = [];
	const app = render(<App builtin={[provider()]} scheduler={scheduler} openUrl={url => opened.push(url)} />);
	const frame = () => app.lastFrame() ?? "";
	const until = async (check: () => boolean, what: string) => {
		const deadline = Date.now() + 4000;
		while (!check()) {
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame()}`);
			await Bun.sleep(15);
		}
	};
	// A screen that opens after async work starts listening just after it first paints.
	const waitFor = async (text: string) => {
		await until(() => frame().includes(text), `"${text}"`);
		await Bun.sleep(40);
	};
	const press = async (...keys: string[]) => {
		for (const key of keys) {
			app.stdin.write(key);
			await Bun.sleep(25);
		}
	};
	return { app, frame, waitFor, until, press, opened, scheduler };
}

async function addKey(ui: ReturnType<typeof startApp>, key: string) {
	await ui.press(ENTER);
	await ui.waitFor("Press Enter to add your key");
	await ui.press(ENTER);
	await ui.waitFor("Add your Mock Cloud key");
	await ui.press(key, ENTER);
}

const tick = (...models: string[]) => updateSettings(s => ({ ...s, selected: { mock: models } }));

// After adding a key the app waits on the provider screen, so setup carries on when you leave it.
async function leaveProvider(ui: ReturnType<typeof startApp>) {
	await ui.waitFor("Tick the models you want");
	await ui.press(ESC);
}

async function passHealthOffer(ui: ReturnType<typeof startApp>) {
	await ui.waitFor("Check that models really work?");
	await ui.press("n");
}

describe("first run", () => {
	test("lists providers and explains what to do, with no other tools installed", async () => {
		const ui = startApp();
		await ui.waitFor("Pick a provider and press Enter to add your key");
		expect(ui.frame()).toContain("Mock Cloud");
		expect(ui.frame()).toContain("no key");
		expect(ui.frame()).toContain("0 models in Droid");
		ui.app.unmount();
	});
});

describe("adding a key", () => {
	test("checks it and saves it, and adds nothing until you tick something", async () => {
		const ui = startApp();
		await addKey(ui, GOOD_KEY);
		await ui.waitFor("Mock Cloud accepted your key");
		await ui.waitFor("0 in Droid");
		expect(getKey("mock")).toBe(GOOD_KEY);
		expect(droidModels()).toEqual([]);
		await ui.press(" ", DOWN, " ");
		await ui.waitFor("2 in Droid");
		await ui.press(ESC);
		await ui.until(() => droidModels().length === 2, "the sync");
		expect(droidModels().map((m: { model: string }) => m.model)).toEqual(["alpha", "beta"]);
		for (const m of droidModels()) {
			expect(m.apiKeyHelper).toEndWith(" key mock");
			expect(JSON.stringify(m)).not.toContain(GOOD_KEY);
		}
		await passHealthOffer(ui);
		await ui.waitFor("Stay up to date?");
		ui.app.unmount();
	});

	test("never shows the key on screen", async () => {
		const ui = startApp();
		await addKey(ui, GOOD_KEY);
		await leaveProvider(ui);
		await passHealthOffer(ui);
		await ui.waitFor("Stay up to date?");
		await ui.press("n");
		await ui.waitFor("Mock Cloud");
		await ui.press(ENTER);
		await ui.waitFor("in Droid");
		expect(ui.frame()).toContain("••••••••1234");
		for (const frame of ui.app.frames) expect(frame).not.toContain(GOOD_KEY);
		ui.app.unmount();
	});

	test("refuses a rejected key and lets you try again", async () => {
		const ui = startApp();
		await addKey(ui, "wrong-key");
		await ui.waitFor("rejected this key");
		expect(readKeys()).toEqual({});
		expect(droidModels()).toEqual([]);
		ui.app.unmount();
	});

	test("backspace edits the key, and esc cancels without saving", async () => {
		const ui = startApp();
		await ui.press(ENTER);
		await ui.waitFor("Press Enter to add your key");
		await ui.press(ENTER);
		await ui.waitFor("Add your Mock Cloud key");
		await ui.press("abc");
		await ui.waitFor("•••");
		await ui.press("\u007F");
		await ui.until(() => ui.frame().includes("••") && !ui.frame().includes("•••"), "one fewer character");
		await ui.press(ESC);
		await ui.waitFor("Press Enter to add your key");
		expect(readKeys()).toEqual({});
		ui.app.unmount();
	});

	test("opens the provider's key page", async () => {
		const ui = startApp();
		await ui.press(ENTER);
		await ui.waitFor("Press Enter to add your key");
		await ui.press("o");
		await ui.until(() => ui.opened.length > 0, "the browser to open");
		expect(ui.opened).toEqual(["https://mock.example/keys"]);
		ui.app.unmount();
	});
});

describe("daily sync offer", () => {
	test("is asked once, after the first key, and honors the answer", async () => {
		const ui = startApp();
		await addKey(ui, GOOD_KEY);
		await leaveProvider(ui);
		await passHealthOffer(ui);
		await ui.waitFor("Stay up to date?");
		expect(ui.frame().replace(/\s+/g, " ")).toContain("never adds or removes models by itself");
		await ui.press("y");
		await ui.waitFor("Mock Cloud");
		expect(ui.scheduler.calls).toEqual(["install"]);
		ui.app.unmount();
	});
});

describe("choosing models", () => {
	test("space changes what Droid gets, and only ticked models go in", async () => {
		saveKey("mock", GOOD_KEY);
		tick("alpha", "beta");
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press(ENTER);
		await ui.waitFor("2 in Droid");
		await ui.press(" ");
		await ui.waitFor("1 in Droid");
		await ui.press(DOWN, DOWN, " ");
		await ui.waitFor("2 in Droid");
		await ui.press(ESC);
		await ui.until(() => droidModels().length === 2, "the sync");
		expect(droidModels().map((m: { model: string }) => m.model).sort()).toEqual(["beta", "gamma"]);
		expect(readSettings().selected.mock?.sort()).toEqual(["beta", "gamma"]);
		ui.app.unmount();
	});

	test("the newest are at the top, and ticked ones come first when you return", async () => {
		saveKey("mock", GOOD_KEY);
		tick("gamma");
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press(ENTER);
		await ui.waitFor("1 in Droid");
		const lines = ui.frame().split("\n").filter(line => /\[[x ]\]/.test(line)).map(line => line.match(/\[[x ]\]\s+(\w+)/)?.[1]);
		expect(lines).toEqual(["gamma", "alpha", "beta"]);
		ui.app.unmount();
	});

	test("search narrows the list, and space ticks what it finds", async () => {
		saveKey("mock", GOOD_KEY);
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press(ENTER);
		await ui.waitFor("0 in Droid");
		await ui.press("/", "gam");
		await ui.waitFor("Search: gam");
		expect(ui.frame()).toContain("gamma");
		expect(ui.frame()).not.toContain("alpha");
		await ui.press(" ");
		await ui.waitFor("1 in Droid");
		expect(readSettings().selected.mock).toEqual(["gamma"]);
		await ui.press(ESC);
		await ui.until(() => ui.frame().includes("alpha"), "the full list to return");
		expect(ui.frame()).toContain("Mock Cloud");
		ui.app.unmount();
	});

	test("letters typed into search don't trigger commands", async () => {
		saveKey("mock", GOOD_KEY);
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press(ENTER);
		await ui.waitFor("0 in Droid");
		await ui.press("/", "d", "a", "o", "j");
		await ui.waitFor("Search: daoj");
		expect(ui.frame()).toContain("No models match");
		expect(ui.opened).toEqual([]);
		expect(getKey("mock")).toBe(GOOD_KEY);
		ui.app.unmount();
	});

	test("a ticked model the provider dropped is shown, and can be unticked", async () => {
		saveKey("mock", GOOD_KEY);
		tick("alpha", "retired-model");
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press(ENTER);
		await ui.waitFor("retired-model");
		await ui.press(DOWN);
		await ui.waitFor("doesn't list this right now");
		await ui.press(" ");
		await ui.until(() => !(readSettings().selected.mock ?? []).includes("retired-model"), "the untick");
		ui.app.unmount();
	});
});

describe("quick key presses", () => {
	test("all count, and space acts on the row the cursor really reached", async () => {
		saveKey("mock", GOOD_KEY);
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press(ENTER);
		await ui.waitFor("0 in Droid");
		// Several keys in one read, as a held arrow key delivers them.
		await ui.press(DOWN + DOWN + " ");
		await ui.waitFor("1 in Droid");
		expect(readSettings().selected.mock).toEqual(["gamma"]);
		ui.app.unmount();
	});

	test("two quick toggles both stick", async () => {
		saveKey("mock", GOOD_KEY);
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press(ENTER);
		await ui.waitFor("0 in Droid");
		await ui.press(` ${DOWN} `);
		await ui.waitFor("2 in Droid");
		expect(readSettings().selected.mock).toEqual(["alpha", "beta"]);
		ui.app.unmount();
	});
});

describe("removing a key", () => {
	test("needs confirming, then takes the models out of Droid and keeps hand-made ones", async () => {
		saveKey("mock", GOOD_KEY);
		mkdirSync(join(dir, ".factory"), { recursive: true });
		writeFileSync(join(dir, ".factory", "settings.json"), JSON.stringify({ customModels: [{ model: "mine", displayName: "Mine", apiKey: "x" }, { model: "alpha", displayName: "A [Mock Cloud]", apiKeyHelper: "/x/droid-models key mock" }] }));
		const ui = startApp();
		await ui.waitFor("1 model");
		await ui.press(ENTER);
		await ui.waitFor("in Droid");
		await ui.press("d");
		await ui.waitFor("take Mock Cloud's models out of Droid?");
		await ui.press("n");
		expect(getKey("mock")).toBe(GOOD_KEY);
		await ui.press("d");
		await ui.waitFor("take Mock Cloud's models out of Droid?");
		await ui.press("y");
		await ui.waitFor("Removed Mock Cloud's key");
		expect(readKeys()).toEqual({});
		expect(droidModels().map((m: { model: string }) => m.model)).toEqual(["mine"]);
		ui.app.unmount();
	});
});

describe("setup with older models already in Droid", () => {
	const url = () => `http://localhost:${server.port}`;
	const seed = () => {
		mkdirSync(join(dir, ".factory"), { recursive: true });
		writeFileSync(
			join(dir, ".factory", "settings.json"),
			JSON.stringify({
				theme: "dark",
				missionModelSettings: { workerModel: "custom:Old-Alpha-0", validatorModel: "custom:Long-Gone-0" },
				sessionDefaultSettings: { specModeModel: "custom:Keep-Me-0" },
				customModels: [
					{ model: "alpha", displayName: "Old Alpha", baseUrl: url(), apiKey: GOOD_KEY, id: "custom:Old-Alpha-0", index: 0 },
					{ model: "gamma", displayName: "Old Gamma", baseUrl: url(), apiKey: GOOD_KEY, index: 1 },
					{ model: "not-offered", displayName: "Old Mystery", baseUrl: url(), apiKey: GOOD_KEY, index: 2 },
					{ model: "beta", displayName: "Other Beta", baseUrl: "https://else.example/v1", apiKey: "other-key", index: 3 },
					{ model: "z", displayName: "Keep Me", baseUrl: "https://else.example/v1", apiKey: "other-key", index: 4 },
				],
			}),
		);
	};
	const names = () => droidModels().map((m: { displayName: string }) => m.displayName);
	const settingsFile = () => JSON.parse(readFileSync(join(dir, ".factory", "settings.json"), "utf8"));

	test("finds the key in Droid, then clears the overlap as part of adding it", async () => {
		seed();
		const ui = startApp();
		await ui.waitFor("Found 1 key");
		await ui.press("i");
		await ui.waitFor("from Droid's custom models");
		await ui.press(ENTER);
		await ui.waitFor("Clean up Droid's model list");
		expect(getKey("mock")).toBe(GOOD_KEY);
		expect(ui.frame()).toContain("Old Alpha");
		expect(ui.frame()).toContain("used by mission workers");
		expect(ui.frame()).toContain("moves into droid-models");
		expect(ui.frame()).toContain("in use by spec mode, so it stays");
		expect(ui.frame()).toContain("mission validators points at custom:Long-Gone-0");
		await ui.press(ENTER);
		await passHealthOffer(ui);
		await ui.waitFor("Stay up to date?");
		await ui.press("n");
		await ui.waitFor("Removed 2 older models");
		// Alpha and Gamma moved in. Mystery isn't offered, so it stayed. The others weren't ticked.
		expect(names().sort()).toEqual(["ALPHA [Mock Cloud]", "GAMMA [Mock Cloud]", "Keep Me", "Old Mystery", "Other Beta"].sort());
		expect(ui.frame()).toContain("Old Mystery");
		expect(readSettings().selected.mock?.sort()).toEqual(["alpha", "gamma"]);
		const file = settingsFile();
		expect(file.theme).toBe("dark");
		expect(file.missionModelSettings.workerModel).toBe("custom:ALPHA-[Mock-Cloud]-0");
		expect(file.sessionDefaultSettings.specModeModel).toBe("custom:Keep-Me-0");
		const backups = readdirSync(join(dir, ".factory")).filter(f => f.includes("before-cleanup"));
		expect(backups).toHaveLength(1);
		expect(statSync(join(dir, ".factory", backups[0] as string)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(join(dir, ".factory", backups[0] as string), "utf8")).customModels).toHaveLength(7);
		for (const frame of ui.app.frames) expect(frame).not.toContain(GOOD_KEY);
		ui.app.unmount();
	});

	test("esc keeps everything, and setup doesn't ask again", async () => {
		seed();
		saveKey("mock", GOOD_KEY);
		const ui = startApp();
		await ui.waitFor("overlap with this app");
		await ui.press("c");
		await ui.waitFor("Clean up Droid's model list");
		await ui.press(ESC);
		await ui.until(() => !ui.frame().includes("Clean up Droid's"), "leaving the screen");
		await ui.until(() => !ui.frame().includes("overlap with this app"), "the banner to go");
		expect(names()).toContain("Old Alpha");
		ui.app.unmount();
		const again = startApp();
		await again.waitFor("Mock Cloud");
		expect(again.frame()).not.toContain("overlap with this app");
		expect(again.frame()).toContain("c clean up");
		again.app.unmount();
	});

	test("space unticks a model, and a model in use can't be ticked", async () => {
		seed();
		saveKey("mock", GOOD_KEY);
		const ui = startApp();
		await ui.waitFor("overlap with this app");
		await ui.press("s");
		await ui.waitFor("Droid's models");
		await ui.press("c");
		await ui.waitFor("Clean up Droid's model list");
		await ui.press(" ", DOWN, DOWN, DOWN, DOWN, " ");
		await ui.until(() => /\[ \] Old Alpha/.test(ui.frame()), "Old Alpha to be unticked");
		expect(ui.frame()).toMatch(/\[ \] Keep Me/);
		ui.app.unmount();
	});
});

describe("a key that stops working", () => {
	test("is flagged, and its models stay put", async () => {
		saveKey("mock", "expired-key");
		tick("alpha");
		mkdirSync(join(dir, ".factory"), { recursive: true });
		writeFileSync(join(dir, ".factory", "settings.json"), JSON.stringify({ customModels: [{ model: "alpha", displayName: "A [Mock Cloud]", apiKeyHelper: "/x/droid-models key mock" }] }));
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press("s");
		await ui.waitFor("Rejected key: Mock Cloud");
		await ui.waitFor("key rejected");
		expect(droidModels()).toHaveLength(1);
		ui.app.unmount();
	});
});

describe("importing", () => {
	test("offers found keys without showing them, and only imports what the provider accepts", async () => {
		mkdirSync(join(dir, ".hermes"), { recursive: true });
		writeFileSync(join(dir, ".hermes", ".env"), `MOCK_API_KEY=${GOOD_KEY}\n`);
		const ui = startApp();
		await ui.waitFor("Found 1 key on this computer");
		await ui.press("i");
		await ui.waitFor("MOCK_API_KEY from ~/.hermes/.env");
		await ui.press(ENTER);
		await passHealthOffer(ui);
		await ui.waitFor("Stay up to date?");
		expect(getKey("mock")).toBe(GOOD_KEY);
		expect(droidModels()).toEqual([]);
		for (const frame of ui.app.frames) expect(frame).not.toContain(GOOD_KEY);
		ui.app.unmount();
	});

	test("never offers a key the provider rejects, and doesn't check it twice", async () => {
		mkdirSync(join(dir, ".hermes"), { recursive: true });
		writeFileSync(join(dir, ".hermes", ".env"), "MOCK_API_KEY=expired\n");
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.until(() => readState().rejectedImports.length === 1, "the key to be checked");
		expect(ui.frame()).not.toContain("Found 1 key");
		expect(ui.frame()).not.toContain("i import");
		expect(readKeys()).toEqual({});
		ui.app.unmount();
		const again = startApp();
		await again.waitFor("Mock Cloud");
		expect(again.frame()).not.toContain("Found 1 key");
		expect(readState().rejectedImports).toHaveLength(1);
		again.app.unmount();
	});
});

describe("the health check is opt-in", () => {
	const requests = () => modelRequests;

	test("explains the cost, and answering no sends no model requests", async () => {
		const ui = startApp();
		await addKey(ui, GOOD_KEY);
		await ui.waitFor("Tick the models you want");
		await ui.press(" ");
		await ui.waitFor("1 in Droid");
		await ui.press(ESC);
		await ui.waitFor("Check that models really work?");
		const text = ui.frame().replace(/\s+/g, " ");
		expect(text).toContain("costs a little on your provider bills");
		expect(text).toContain("A retry or image test can add up to two more requests");
		expect(text).toContain("stays off unless you turn it on");
		await ui.press("n");
		await ui.waitFor("Stay up to date?");
		expect(readSettings().healthCheck).toBe(false);
		await ui.press("n");
		await ui.waitFor("Mock Cloud");
		await ui.press("s");
		await ui.waitFor("up to date");
		expect(requests()).toEqual([]);
		expect(readHealth()).toEqual({});
		ui.app.unmount();
	});

	test("answering yes checks ticked models and keeps a failing one out of Droid", async () => {
		const ui = startApp();
		await addKey(ui, GOOD_KEY);
		await ui.waitFor("Tick the models you want");
		await ui.press(" ", DOWN, " ");
		await ui.waitFor("2 in Droid");
		await ui.press(ESC);
		await ui.waitFor("Check that models really work?");
		await ui.press("y");
		await ui.waitFor("Stay up to date?");
		await ui.press("n");
		await ui.until(() => readHealth().mock !== undefined, "the first checked sync");
		await ui.waitFor("1 failing and kept out of Droid");
		expect(readSettings().healthCheck).toBe(true);
		expect(droidModels().map((m: { model: string }) => m.model)).toEqual(["beta"]);
		expect(readHealth().mock?.alpha?.status).toBe("failed");
		expect(requests().sort()).toEqual(["alpha", "beta"]);
		ui.app.unmount();
	});

	test("a failing ticked model is flagged with the reason, and can be unticked", async () => {
		saveKey("mock", GOOD_KEY);
		updateSettings(s => ({ ...s, healthCheck: true, selected: { mock: ["alpha", "beta"] } }));
		writeHealth({ mock: { alpha: { status: "failed", checkedAt: new Date().toISOString(), reason: "Model is retired" } } });
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press(ENTER);
		await ui.waitFor("1 in Droid");
		expect(ui.frame()).toContain("[!]");
		await ui.waitFor("Kept out of Droid: Model is retired");
		await ui.press(" ");
		await ui.until(() => readSettings().selected.mock?.join() === "beta", "the untick");
		ui.app.unmount();
	});

	test("Settings goes through the same explanation, and turning it off is immediate", async () => {
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press(",");
		await ui.waitFor("Health check (small cost)");
		await ui.press(DOWN, DOWN, "\u001B[C");
		await ui.waitFor("costs a little on your provider bills");
		await ui.press("n");
		await ui.waitFor("Mock Cloud");
		expect(readSettings().healthCheck).toBe(false);
		ui.app.unmount();
	});
});

describe("settings", () => {
	test("changing a setting updates Droid when you leave", async () => {
		saveKey("mock", GOOD_KEY);
		tick("alpha");
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press(",");
		await ui.waitFor("Default reasoning");
		expect(ui.frame()).not.toContain("Models per provider");
		expect(ui.frame()).not.toContain("Price cap");
		await ui.press("\u001B[D");
		await ui.waitFor("‹ medium ›");
		await ui.press(ESC);
		await ui.until(() => droidModels().length === 1, "the sync");
		expect(readSettings().reasoningEffort).toBe("medium");
		ui.app.unmount();
	});

	test("the daily sync toggle turns the job on and off", async () => {
		const ui = startApp();
		await ui.waitFor("Mock Cloud");
		await ui.press(",");
		await ui.waitFor("Daily sync");
		await ui.press(DOWN, "\u001B[C");
		await ui.waitFor("‹ on ›");
		await ui.press("\u001B[C");
		await ui.waitFor("‹ off ›");
		expect(ui.scheduler.calls).toEqual(["install", "remove"]);
		ui.app.unmount();
	});
});
