import { Box, render, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { chooseModels, type Entry, type Model, type Plan, planProvider, toggleModel, usableModels, verifyKey } from "./catalog";
import { findLeftovers, findStaleRefs, finishCleanup, fingerprint, isPreTicked, type Leftover, pinModels } from "./cleanup";
import { droidSettingsPath, readDroidSettings } from "./droid";
import { type FoundKey, findKeys, importFingerprint } from "./importer";
import { allProviders, checkCustomProviders, PROVIDERS, type Provider } from "./providers";
import { launchdScheduler, type Scheduler } from "./schedule";
import { type HealthMap, readHealth, readKeys, readSettings, readState, removeKey, saveKey, type Settings, type State, updateSettings, updateState, writeSettings } from "./store";
import { type DroidSummary, fetchModelsDev, removeFromDroid, runSync, summarizeDroid } from "./sync";

type View =
	| { name: "home" }
	| { name: "provider"; id: string }
	| { name: "key"; id: string }
	| { name: "import" }
	| { name: "settings" }
	| { name: "cleanup" }
	| { name: "offerHealth"; duringSetup: boolean }
	| { name: "offerSchedule" };

type NoticeKind = "good" | "warn" | "bad";
interface Notice {
	kind: NoticeKind;
	text: string;
}

const NOTICE_COLORS: Record<NoticeKind, string> = { good: "green", warn: "yellow", bad: "red" };

interface Snapshot {
	settings: Settings;
	keys: Record<string, string>;
	state: State;
	summary: DroidSummary;
	providers: Provider[];
	droidEntries: Entry[];
	leftovers: Leftover[];
	staleRefs: { setting: string; value: string }[];
	health: HealthMap;
	providerProblems: string[];
}

function readDroidSafely(): Entry {
	try {
		return readDroidSettings();
	} catch {
		return {};
	}
}

function loadSnapshot(builtin: Provider[]): Snapshot {
	const settings = readSettings();
	const providers = allProviders(settings.customProviders, builtin);
	const keys = readKeys();
	const droid = readDroidSafely();
	return {
		settings,
		keys,
		state: readState(),
		summary: summarizeDroid(providers),
		providers,
		droidEntries: droid.customModels ?? [],
		leftovers: findLeftovers(droid, providers, keys),
		staleRefs: findStaleRefs(droid),
		health: readHealth(),
		providerProblems: checkCustomProviders(settings.customProviders, builtin).problems,
	};
}

const formatTokens = (n?: number) => {
	if (!n) return "?";
	return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`;
};
const formatPrice = (n?: number) => (n === undefined ? "?" : `${n}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function timeAgo(iso?: string) {
	if (!iso) return "not synced yet";
	const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
	if (minutes < 1) return "synced just now";
	if (minutes < 60) return `synced ${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `synced ${hours}h ago` : `synced ${Math.round(hours / 24)}d ago`;
}

function openInBrowser(url: string) {
	Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

function Screen({ title, right, footer, notice, busy, children }: { title: string; right?: string; footer: string; notice?: Notice | null; busy?: string | null; children: ReactNode }) {
	const { rows } = useWindowSize();
	return (
		<Box flexDirection="column" height={rows || undefined} paddingX={1}>
			<Box justifyContent="space-between">
				<Text bold color="cyan">
					{title}
				</Text>
				{right ? <Text dimColor>{right}</Text> : null}
			</Box>
			<Box flexDirection="column" flexGrow={1} marginTop={1}>
				{children}
			</Box>
			{busy ? <Text color="yellow">{busy}…</Text> : notice ? <Text color={NOTICE_COLORS[notice.kind]}>{notice.text}</Text> : null}
			<Text dimColor>{footer}</Text>
		</Box>
	);
}

// Keeps the cursor in view on lists longer than the terminal.
function visibleWindow<T>(items: T[], cursor: number, height: number) {
	const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), items.length - height));
	return { start, items: items.slice(start, start + height), hiddenAfter: Math.max(0, items.length - start - height) };
}

const moveCursor = (cursor: number, delta: number, count: number) => (count === 0 ? 0 : Math.max(0, Math.min(count - 1, cursor + delta)));

// Held or quickly pressed keys arrive before the next render, so the position can't live in render state alone.
function useListCursor(count: number) {
	const position = useRef(0);
	const [, rerender] = useState(0);
	position.current = moveCursor(position.current, 0, count);
	return {
		position: position.current,
		current: () => position.current,
		move(delta: number) {
			position.current = moveCursor(position.current, delta, count);
			rerender(n => n + 1);
		},
		reset() {
			position.current = 0;
			rerender(n => n + 1);
		},
	};
}

function ProviderRow({ provider, active, snapshot }: { provider: Provider; active: boolean; snapshot: Snapshot }) {
	const hasKey = Boolean(snapshot.keys[provider.id]);
	const rejected = hasKey && snapshot.state.rejected.includes(provider.id);
	const count = snapshot.summary.counts[provider.id] ?? 0;
	const [icon, color] = rejected ? ["!", "red"] : hasKey ? ["●", "green"] : ["○", "gray"];
	const detail = rejected ? "key rejected" : hasKey ? plural(count, "model") : "no key";
	return (
		<Box>
			<Text color={active ? "cyan" : undefined}>{active ? "› " : "  "}</Text>
			<Text color={color}>{icon} </Text>
			<Box width={32}>
				<Text bold={active}>{provider.label}</Text>
			</Box>
			<Text color={rejected ? "red" : undefined} dimColor={!hasKey}>
				{detail}
			</Text>
		</Box>
	);
}

// Older models that overlap with this app and haven't been dealt with.
const leftoversToReview = (snapshot: Snapshot) => snapshot.leftovers.filter(l => l.kind !== "other" && !snapshot.state.keptLeftovers.includes(fingerprint(l)));

function Home(props: { snapshot: Snapshot; found: number; notice: Notice | null; busy: string | null; onOpen: (id: string) => void; onSync: () => void; onImport: () => void; onCleanup: () => void; onSettings: () => void; onQuit: () => void }) {
	const { snapshot, found } = props;
	const toReview = leftoversToReview(snapshot).length;
	const canCleanUp = snapshot.leftovers.length > 0;
	const { rows } = useWindowSize();
	const [filter, setFilter] = useState<string | null>(null);
	const list = useMemo(() => {
		const hasKey = (p: Provider) => (snapshot.keys[p.id] ? 0 : 1);
		const sorted = snapshot.providers.map((p, i) => ({ p, i })).sort((a, b) => hasKey(a.p) - hasKey(b.p) || a.i - b.i).map(({ p }) => p);
		return filter ? sorted.filter(p => p.label.toLowerCase().includes(filter.toLowerCase())) : sorted;
	}, [snapshot, filter]);
	const cursor = useListCursor(list.length);
	const openCurrent = () => {
		const provider = list[cursor.current()];
		if (provider) props.onOpen(provider.id);
	};

	useInput((input, key) => {
		if (key.upArrow) return cursor.move(-1);
		if (key.downArrow) return cursor.move(1);
		if (key.return) return openCurrent();
		if (filter !== null) {
			if (key.escape) return setFilter(null);
			if (key.backspace || key.delete) return setFilter(current => (current ?? "").slice(0, -1));
			if (input && !key.ctrl && !key.meta) {
				cursor.reset();
				setFilter(current => (current ?? "") + input);
			}
			return;
		}
		if (input === "k") return cursor.move(-1);
		if (input === "j") return cursor.move(1);
		if (input === "/") return setFilter("");
		if (input === "s" && !props.busy) return props.onSync();
		if (input === "i" && found > 0) return props.onImport();
		if (input === "c" && canCleanUp) return props.onCleanup();
		if (input === ",") return props.onSettings();
		if (input === "q") return props.onQuit();
	});

	const connected = Object.keys(snapshot.keys).length;
	const reserved = 6 + (filter !== null ? 1 : 0) + (found > 0 ? 2 : 0) + (connected === 0 ? 2 : 0) + (toReview > 0 ? 2 : 0) + snapshot.providerProblems.length;
	const window = visibleWindow(list, cursor.position, Math.max(3, (rows || 24) - reserved));
	const right = snapshot.summary.unreadable ? "Droid's settings are unreadable" : `${plural(snapshot.summary.total, "model")} in Droid · ${timeAgo(snapshot.state.lastSyncAt)}`;
	return (
		<Screen title="droid-models" right={right} notice={props.notice} busy={props.busy} footer={`↑↓ move · enter open · / search · s sync${found > 0 ? " · i import" : ""}${canCleanUp ? " · c clean up" : ""} · , settings · q quit`}>
			{connected === 0 ? (
				<Box marginBottom={1}>
					<Text>Pick a provider and press Enter to add your key. Its models then appear in Droid.</Text>
				</Box>
			) : null}
			{found > 0 ? (
				<Box marginBottom={1}>
					<Text color="yellow">Found {plural(found, "key")} on this computer. Press i to review and import.</Text>
				</Box>
			) : null}
			{toReview > 0 ? (
				<Box marginBottom={1}>
					<Text color="yellow">{plural(toReview, "older model")} in Droid overlap with this app. Press c to review.</Text>
				</Box>
			) : null}
			{snapshot.providerProblems.map(problem => (
				<Text key={problem} color="yellow">
					{problem}
				</Text>
			))}
			{filter !== null ? <Text>Search: {filter}▏</Text> : null}
			{window.items.map(provider => (
				<ProviderRow key={provider.id} provider={provider} active={provider.id === list[cursor.position]?.id} snapshot={snapshot} />
			))}
			{list.length === 0 ? <Text dimColor>No providers match.</Text> : null}
			{window.hiddenAfter > 0 ? <Text dimColor>  ↓ {window.hiddenAfter} more</Text> : null}
		</Screen>
	);
}

function ProviderScreen(props: { provider: Provider; snapshot: Snapshot; notice: Notice | null; busy: string | null; onBack: (changed: boolean) => void; onAddKey: () => void; onRemoveKey: () => void; onOpenUrl: (url: string) => void; onToggle: (modelId: string, available: Model[]) => void }) {
	const { provider, snapshot } = props;
	const key = snapshot.keys[provider.id] ?? null;
	const { rows, columns } = useWindowSize();
	const [plan, setPlan] = useState<Plan | null>(null);
	const [order, setOrder] = useState<Model[]>([]);
	const cursor = useListCursor(order.length);
	const [confirming, setConfirming] = useState(false);
	const changed = useRef(false);

	// biome-ignore lint: reload only when the provider or key changes, not on each pick.
	useEffect(() => {
		let current = true;
		(async () => {
			const modelsDev = await fetchModelsDev(snapshot.settings);
			const loaded = await planProvider(provider, key, snapshot.settings, modelsDev);
			if (!current) return;
			setPlan(loaded);
			setOrder([...loaded.selected, ...loaded.available.filter(m => !loaded.selected.includes(m))]);
		})();
		return () => {
			current = false;
		};
	}, [provider.id, key]);

	// Results only count for users who opted in to health checks.
	const health = snapshot.settings.healthCheck ? snapshot.health[provider.id] : undefined;
	const selectedIds = useMemo(() => new Set(plan ? chooseModels(usableModels(plan.available, health), provider, snapshot.settings).map(m => m.id) : []), [plan, health, provider, snapshot.settings]);

	useInput((input, inkKey) => {
		if (confirming) {
			if (input === "y") props.onRemoveKey();
			else setConfirming(false);
			return;
		}
		if (inkKey.escape) return props.onBack(changed.current);
		if (inkKey.upArrow || input === "k") return cursor.move(-1);
		if (inkKey.downArrow || input === "j") return cursor.move(1);
		if (input === "a" || (inkKey.return && !key)) return props.onAddKey();
		if (input === "d" && key) return setConfirming(true);
		if (input === "o" && provider.keyUrl) return props.onOpenUrl(provider.keyUrl);
		if (input === " " && plan) {
			const model = order[cursor.current()];
			if (!model || health?.[model.id]?.status === "failed") return;
			changed.current = true;
			props.onToggle(model.id, usableModels(plan.available, health));
		}
	});

	const rejected = plan?.keyRejected || (key !== null && snapshot.state.rejected.includes(provider.id));
	const activeHealth = health?.[order[cursor.position]?.id ?? ""];
	const window = visibleWindow(order, cursor.position, Math.max(3, (rows || 24) - 12 - (activeHealth?.status === "failed" ? 1 : 0)));
	// Leaves room for the health mark, so checked and unchecked rows line up.
	const idWidth = Math.max(20, (columns || 80) - 36);
	const keyLine = key ? `••••••••${key.slice(-4)}` : "none yet";
	const footer = confirming ? "y remove · any other key cancels" : `↑↓ move · space pick · a ${key ? "replace" : "add"} key${key ? " · d remove key" : ""}${provider.keyUrl ? " · o open key page" : ""} · esc back`;
	return (
		<Screen title={provider.label} right={provider.tested ? undefined : "untested with a real key"} notice={props.notice} busy={props.busy} footer={footer}>
			<Text>
				Key: <Text color={rejected ? "red" : key ? "green" : undefined}>{keyLine}</Text>
				{rejected ? <Text color="red"> rejected by {provider.label}. Press a to replace it.</Text> : null}
			</Text>
			{provider.keyUrl ? <Text dimColor>Get a key: {provider.keyUrl}</Text> : null}
			{confirming ? (
				<Box marginTop={1}>
					<Text color="yellow">Remove this key and take {provider.label}'s models out of Droid?</Text>
				</Box>
			) : !key ? (
				<Box marginTop={1}>
					<Text color="cyan">Press Enter to add your key.</Text>
				</Box>
			) : null}
			<Box marginTop={1} flexDirection="column">
				{!plan ? <Text dimColor>Loading models…</Text> : null}
				{plan && !plan.keyRejected ? (
					<Text bold>
						{key ? `${selectedIds.size} in Droid` : `${selectedIds.size} would be added`}
						<Text dimColor bold={false}>
							{" "}of {order.length} available (list from {plan.listSource})
						</Text>
					</Text>
				) : null}
				{plan?.listSource === "nowhere" && !plan.keyRejected ? <Text dimColor>Models will load after you add a key.</Text> : null}
				{window.items.length > 0 ? (
					<Box>
						<Box width={6} />
						<Box width={idWidth}>
							<Text dimColor>model</Text>
						</Box>
						<Box width={8}>
							<Text dimColor>context</Text>
						</Box>
						<Box width={8}>
							<Text dimColor>$/M out</Text>
						</Box>
						<Text dimColor>released</Text>
					</Box>
				) : null}
				{window.items.map((m, i) => {
					const active = window.start + i === cursor.position;
					return (
						<Box key={m.id}>
							<Text color={active ? "cyan" : undefined}>{active ? "› " : "  "}</Text>
							{health?.[m.id]?.status === "failed" ? <Text color="red">[!] </Text> : <Text color={selectedIds.has(m.id) ? "green" : "gray"}>{selectedIds.has(m.id) ? "[x] " : "[ ] "}</Text>}
							<Box width={idWidth}>
								<Text bold={active} wrap="truncate">
									{m.id}
								</Text>
							</Box>
							<Box width={8}>
								<Text dimColor>{formatTokens(m.context)}</Text>
							</Box>
							<Box width={8}>
								<Text dimColor>{formatPrice(m.outputPrice)}</Text>
							</Box>
							<Text dimColor>{m.released}</Text>
							{health?.[m.id]?.status === "ok" ? <Text color="green"> ✓</Text> : null}
						</Box>
					);
				})}
				{window.hiddenAfter > 0 ? <Text dimColor>  ↓ {window.hiddenAfter} more</Text> : null}
				{activeHealth?.status === "failed" ? <Text color="red">Kept out of Droid: {activeHealth.reason}. Checked again at the next sync.</Text> : null}
			</Box>
		</Screen>
	);
}

function KeyEntry(props: { provider: Provider; onCancel: () => void; onSaved: (message: Notice) => void; onOpenUrl: (url: string) => void }) {
	const { provider } = props;
	const value = useRef("");
	const [length, setLength] = useState(0);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const update = (next: string) => {
		value.current = next;
		setLength(next.length);
		setError(null);
	};
	const append = (text: string) => update(value.current + text.replace(/\s/g, ""));

	const submit = async () => {
		if (!value.current || checking) return;
		setChecking(true);
		const result = await verifyKey(provider, value.current);
		setChecking(false);
		if (result === "rejected") return setError(`${provider.label} rejected this key. Check it and try again.`);
		if (result === "subscription") return setError("That's a Claude subscription login, which only Anthropic's own apps may use. Use an API key instead.");
		saveKey(provider.id, value.current);
		props.onSaved(result === "accepted" ? { kind: "good", text: `${provider.label} accepted your key.` } : { kind: "warn", text: `Key saved. ${provider.label} can't confirm keys in advance, so your first request will show whether it works.` });
	};

	useInput((input, key) => {
		if (checking) return;
		if (key.escape) return props.onCancel();
		if (key.return) return void submit();
		if (key.backspace || key.delete) return update(value.current.slice(0, -1));
		if (key.ctrl && input === "o" && provider.keyUrl) return props.onOpenUrl(provider.keyUrl);
		if (key.ctrl && input === "u") return update("");
		if (input && !key.ctrl && !key.meta) append(input);
	});
	usePaste(append);

	return (
		<Screen title={`Add your ${provider.label} key`} busy={checking ? "Checking the key" : null} notice={error ? { kind: "bad", text: error } : null} footer={`enter save · ctrl+u clear${provider.keyUrl ? " · ctrl+o open key page" : ""} · esc cancel`}>
			{provider.keyUrl ? <Text>Create one at <Text color="cyan">{provider.keyUrl}</Text></Text> : null}
			<Box marginTop={1}>
				<Text>Key: </Text>
				<Text color="green">{"•".repeat(Math.min(length, 60))}</Text>
				<Text>▏</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>Saved only on this computer, in a file only your account can read.</Text>
			</Box>
		</Screen>
	);
}

function ImportScreen(props: { found: FoundKey[]; onCancel: () => void; onImport: (chosen: FoundKey[]) => void }) {
	const cursor = useListCursor(props.found.length);
	const [chosen, setChosen] = useState(() => new Set(props.found.map(f => f.provider.id)));

	useInput((input, key) => {
		if (key.escape) return props.onCancel();
		if (key.upArrow || input === "k") return cursor.move(-1);
		if (key.downArrow || input === "j") return cursor.move(1);
		if (input === " ") {
			const id = props.found[cursor.current()]?.provider.id;
			if (!id) return;
			return setChosen(current => {
				const next = new Set(current);
				if (!next.delete(id)) next.add(id);
				return next;
			});
		}
		if (key.return) return props.onImport(props.found.filter(f => chosen.has(f.provider.id)));
	});

	return (
		<Screen title="Import keys" footer="↑↓ move · space pick · enter import · esc cancel">
			<Box marginBottom={1}>
				<Text>Each key is checked with its provider before it's copied in. The original stays where it is.</Text>
			</Box>
			{props.found.map((f, i) => (
				<Box key={f.provider.id}>
					<Text color={i === cursor.position ? "cyan" : undefined}>{i === cursor.position ? "› " : "  "}</Text>
					<Text color={chosen.has(f.provider.id) ? "green" : "gray"}>{chosen.has(f.provider.id) ? "[x] " : "[ ] "}</Text>
					<Box width={32}>
						<Text bold={i === cursor.position}>{f.provider.label}</Text>
					</Box>
					<Text dimColor>{f.envName ? `${f.envName} from ${f.source}` : `from ${f.source}`}</Text>
				</Box>
			))}
		</Screen>
	);
}

function leftoverNote(l: Leftover) {
	const use = l.usedBy.length ? ` · used by ${l.usedBy.join(", ")}` : "";
	if (l.kind === "duplicate") return `same as ${l.replacement?.displayName}${use}`;
	if (l.kind === "similar") return `same model, different ${l.differences.join(", ")}${use}`;
	if (l.kind === "sameProvider") return l.differences.length ? `would lose its own ${l.differences.join(", ")}${use}` : `moves into droid-models${use}`;
	if (!l.removable) return `in use by ${l.usedBy.join(", ")}, so it stays`;
	return l.alsoVia ? `different provider, also here via ${l.alsoVia}` : "not managed by this app";
}

function CleanupScreen(props: { leftovers: Leftover[]; staleRefs: { setting: string; value: string }[]; onSkip: () => void; onApply: (chosen: Leftover[]) => void }) {
	const { leftovers, staleRefs } = props;
	const { rows } = useWindowSize();
	const cursor = useListCursor(leftovers.length);
	const [chosen, setChosen] = useState(() => new Set(leftovers.filter(isPreTicked).map(fingerprint)));

	useInput((input, key) => {
		if (key.escape) return props.onSkip();
		if (key.upArrow || input === "k") return cursor.move(-1);
		if (key.downArrow || input === "j") return cursor.move(1);
		if (input === " ") {
			const leftover = leftovers[cursor.current()];
			if (!leftover?.removable) return;
			return setChosen(current => {
				const next = new Set(current);
				if (!next.delete(fingerprint(leftover))) next.add(fingerprint(leftover));
				return next;
			});
		}
		if (key.return) {
			const picked = leftovers.filter(l => chosen.has(fingerprint(l)));
			return picked.length > 0 ? props.onApply(picked) : props.onSkip();
		}
	});

	const window = visibleWindow(leftovers, cursor.position, Math.max(3, (rows || 24) - 8 - staleRefs.length));
	return (
		<Screen title="Clean up Droid's model list" footer="↑↓ move · space pick · enter remove ticked · esc keep all">
			<Box marginBottom={1}>
				<Text>These models were already in Droid. Ticked ones are exact overlaps with droid-models. Unticked ones have settings of their own, so check before removing them.</Text>
			</Box>
			{window.items.map((l, i) => {
				const active = window.start + i === cursor.position;
				return (
					<Box key={`${fingerprint(l)}-${window.start + i}`}>
						<Text color={active ? "cyan" : undefined}>{active ? "› " : "  "}</Text>
						<Text color={chosen.has(fingerprint(l)) ? "green" : "gray"}>{chosen.has(fingerprint(l)) ? "[x] " : "[ ] "}</Text>
						<Box width={38}>
							<Text bold={active} wrap="truncate">
								{String(l.entry.displayName)}
							</Text>
						</Box>
						<Text dimColor wrap="truncate">
							{leftoverNote(l)}
						</Text>
					</Box>
				);
			})}
			{window.hiddenAfter > 0 ? <Text dimColor>  ↓ {window.hiddenAfter} more</Text> : null}
			{staleRefs.map(ref => (
				<Text key={ref.setting} color="yellow">
					Heads up: {ref.setting} points at {ref.value}, which isn't in Droid. Change it in Droid's settings.
				</Text>
			))}
		</Screen>
	);
}

const NEWEST_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20];
const CAP_OPTIONS: (number | null)[] = [0.5, 1, 2, 3, 5, 10, 20, null];
const CONTEXT_OPTIONS = [32000, 64000, 128000, 200000, 400000, 1000000];
const EFFORT_OPTIONS: (string | null)[] = [null, "low", "medium", "high"];

function SettingsScreen(props: { settings: Settings; scheduler: Scheduler; onDone: (settings: Settings, changed: boolean) => void; onToggleSchedule: () => string | null; onOfferHealth: (settings: Settings) => void }) {
	const [settings, setSettings] = useState(props.settings);
	const [scheduled, setScheduled] = useState(props.scheduler.installed());
	const [error, setError] = useState<string | null>(null);

	const step = <T,>(options: T[], current: T, delta: number): T => {
		const index = options.indexOf(current);
		return options[moveCursor(index < 0 ? 0 : index, delta, options.length)] as T;
	};
	const rows: { label: string; value: string; change: (delta: number) => void }[] = [
		{ label: "Models per provider", value: `${settings.newestPerProvider}`, change: d => setSettings(s => ({ ...s, newestPerProvider: step(NEWEST_OPTIONS, s.newestPerProvider, d) })) },
		{ label: "Price cap, pay-per-use providers", value: settings.maxOutputPrice === null ? "no cap" : `${settings.maxOutputPrice} USD per million output tokens`, change: d => setSettings(s => ({ ...s, maxOutputPrice: step(CAP_OPTIONS, s.maxOutputPrice, d) })) },
		{ label: "Smallest context window", value: formatTokens(settings.minContext), change: d => setSettings(s => ({ ...s, minContext: step(CONTEXT_OPTIONS, s.minContext, d) })) },
		{ label: "Default reasoning", value: settings.reasoningEffort ?? "off", change: d => setSettings(s => ({ ...s, reasoningEffort: step(EFFORT_OPTIONS, s.reasoningEffort, d) })) },
	];
	if (props.scheduler.supported) {
		rows.push({
			label: "Daily sync",
			value: scheduled ? "on" : "off",
			change: () => {
				setError(props.onToggleSchedule());
				setScheduled(props.scheduler.installed());
			},
		});
	}
	rows.push({
		label: "Health check (small cost)",
		value: settings.healthCheck ? "on" : "off",
		// Turning it on goes through the screen that explains the cost.
		change: () => (settings.healthCheck ? setSettings(s => ({ ...s, healthCheck: false })) : props.onOfferHealth(settings)),
	});
	const cursor = useListCursor(rows.length);

	useInput((input, key) => {
		if (key.escape) return props.onDone(settings, JSON.stringify(settings) !== JSON.stringify(props.settings));
		if (key.upArrow || input === "k") return cursor.move(-1);
		if (key.downArrow || input === "j") return cursor.move(1);
		if (key.leftArrow || input === "h") return rows[cursor.current()]?.change(-1);
		if (key.rightArrow || input === "l" || input === " ") return rows[cursor.current()]?.change(1);
	});

	return (
		<Screen title="Settings" notice={error ? { kind: "bad", text: error } : null} footer="↑↓ move · ←→ change · esc save and go back">
			{rows.map((row, i) => (
				<Box key={row.label}>
					<Text color={i === cursor.position ? "cyan" : undefined}>{i === cursor.position ? "› " : "  "}</Text>
					<Box width={36}>
						<Text bold={i === cursor.position}>{row.label}</Text>
					</Box>
					<Text color={i === cursor.position ? "cyan" : undefined}>{i === cursor.position ? `‹ ${row.value} ›` : `  ${row.value}`}</Text>
				</Box>
			))}
			<Box marginTop={1}>
				<Text dimColor>Droid's settings file: {droidSettingsPath()}</Text>
			</Box>
		</Screen>
	);
}

function OfferHealthCheck(props: { onAnswer: (yes: boolean) => void }) {
	useInput(input => {
		if (input === "y") props.onAnswer(true);
		if (input === "n") props.onAnswer(false);
	});
	return (
		<Screen title="Check that models really work?" footer="y turn on · n leave off">
			<Text>Some providers list models that are down, or that can't work with Droid. With this on, droid-models sends each model a tiny real request and keeps failing ones out of Droid.</Text>
			<Box marginTop={1}>
				<Text color="yellow">This uses your API keys, so it costs a little on your provider bills: usually under 1 cent per model.</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>New models are checked once, working ones about once a week, and failing ones at each sync. A retry or image test can add up to two more requests for a model. It stays off unless you turn it on, and you can change this any time in Settings.</Text>
			</Box>
		</Screen>
	);
}

function OfferSchedule(props: { onAnswer: (yes: boolean) => void }) {
	useInput(input => {
		if (input === "y") props.onAnswer(true);
		if (input === "n") props.onAnswer(false);
	});
	return (
		<Screen title="Stay up to date?" footer="y yes · n no">
			<Text>New models can appear in Droid by themselves. droid-models would run a quick check at login and each morning.</Text>
			<Box marginTop={1}>
				<Text dimColor>You can change this any time in Settings.</Text>
			</Box>
		</Screen>
	);
}

export function App({ builtin = PROVIDERS, scheduler = launchdScheduler, openUrl = openInBrowser }: { builtin?: Provider[]; scheduler?: Scheduler; openUrl?: (url: string) => void }) {
	const { exit } = useApp();
	const [view, setView] = useState<View>({ name: "home" });
	const [snapshot, setSnapshot] = useState(() => loadSnapshot(builtin));
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [found, setFound] = useState<FoundKey[]>([]);
	const storedProviders = Object.keys(snapshot.keys).join();

	// Only offer keys that still work, so nobody is asked about a dead one. Each key goes only to its own provider.
	// biome-ignore lint: rerun only when the set of saved keys changes.
	useEffect(() => {
		let current = true;
		(async () => {
			const fresh = loadSnapshot(builtin);
			const remembered = new Set(fresh.state.rejectedImports);
			const candidates = findKeys(fresh.providers, fresh.keys, fresh.droidEntries).filter(f => !remembered.has(importFingerprint(f)));
			const checks = await Promise.all(candidates.map(async f => ({ f, result: await verifyKey(f.provider, f.key) })));
			if (!current) return;
			const dead = checks.filter(c => c.result === "rejected" || c.result === "subscription").map(c => importFingerprint(c.f));
			if (dead.length > 0) {
				updateState(state => ({ ...state, rejectedImports: [...new Set([...state.rejectedImports, ...dead])] }));
			}
			setFound(checks.filter(c => c.result === "accepted" || c.result === "unverified").map(c => c.f));
		})();
		return () => {
			current = false;
		};
	}, [storedProviders]);

	const refresh = () => setSnapshot(loadSnapshot(builtin));

	// Returns a sentence about the result, for callers to combine with their own news.
	const sync = async (): Promise<Notice> => {
		setBusy("Updating Droid's models");
		const result = await runSync({ providers: () => loadSnapshot(builtin).providers });
		setBusy(null);
		refresh();
		if (result.problem) return { kind: "bad", text: result.problem };
		const rejected = result.plans.filter(p => p.keyRejected).map(p => p.provider.label);
		if (rejected.length > 0) return { kind: "bad", text: `Rejected key: ${rejected.join(", ")}. Open the provider to replace it.` };
		const changes = [result.added.length ? `${result.added.length} added` : "", result.removed.length ? `${result.removed.length} removed` : ""].filter(Boolean).join(", ");
		const summary = changes ? `Droid's models updated: ${changes}.` : "Droid's models are up to date.";
		const checks = result.checked > 0 ? ` Checked ${plural(result.checked, "model")}${result.failing.length ? `, ${result.failing.length} failing and kept out of Droid` : ""}.` : "";
		const outages = result.outages.length ? ` Every model failed on ${result.outages.join(", ")}, so those weren't changed.` : "";
		return { kind: result.failing.length || result.outages.length ? "warn" : "good", text: `${summary}${checks}${outages}` };
	};

	const afterFirstKey = () => {
		const state = readState();
		if (!scheduler.supported || scheduler.installed() || state.scheduleAsked) return false;
		updateState(s => ({ ...s, scheduleAsked: true }));
		setView({ name: "offerSchedule" });
		return true;
	};

	const offerNextStep = () => {
		const state = readState();
		if (state.healthAsked) return afterFirstKey();
		updateState(s => ({ ...s, healthAsked: true }));
		setView({ name: "offerHealth", duringSetup: true });
	};

	// The steps after adding a key: clear up any overlap, then the opt-in health check, then daily sync.
	const continueSetup = () => {
		if (leftoversToReview(loadSnapshot(builtin)).length > 0) {
			setView({ name: "cleanup" });
			return;
		}
		offerNextStep();
	};

	const keepLeftovers = () => {
		const fresh = loadSnapshot(builtin);
		updateState(state => ({ ...state, keptLeftovers: [...new Set([...state.keptLeftovers, ...fresh.leftovers.map(fingerprint)])] }));
		refresh();
		setView({ name: "home" });
		offerNextStep();
	};

	const cleanUp = async (chosen: Leftover[]) => {
		setView({ name: "home" });
		setBusy("Cleaning up");
		pinModels(chosen);
		const providers = loadSnapshot(builtin).providers;
		if (chosen.some(l => l.kind === "sameProvider")) await runSync({ providers: () => loadSnapshot(builtin).providers });
		let message: Notice;
		try {
			const result = finishCleanup(chosen, providers, readKeys());
			const kept = result.kept.length ? ` Kept, because the provider doesn't list it: ${result.kept.join(", ")}.` : "";
			const backup = result.backup ? ` Backup: ${result.backup.split("/").pop()}.` : "";
			message = { kind: result.kept.length ? "warn" : "good", text: `Removed ${plural(result.removed.length, "older model")}.${backup}${kept}` };
		} catch {
			message = { kind: "bad", text: "Droid's settings file isn't plain JSON, so it wasn't changed." };
		}
		// Whatever is still listed was reviewed, so setup shouldn't ask about it again.
		const fresh = loadSnapshot(builtin);
		updateState(state => ({ ...state, keptLeftovers: [...new Set([...state.keptLeftovers, ...fresh.leftovers.map(fingerprint)])] }));
		setBusy(null);
		refresh();
		setNotice(message);
		offerNextStep();
	};

	const importKeys = async (chosen: FoundKey[]) => {
		setView({ name: "home" });
		setBusy("Checking keys");
		const checks = await Promise.all(chosen.map(async f => ({ f, result: await verifyKey(f.provider, f.key) })));
		const usable = checks.filter(c => c.result === "accepted" || c.result === "unverified");
		for (const { f } of usable) saveKey(f.provider.id, f.key);
		const rejected = checks.filter(c => !usable.includes(c));
		if (rejected.length > 0) {
			updateState(state => ({ ...state, rejectedImports: [...new Set([...state.rejectedImports, ...rejected.map(c => importFingerprint(c.f))])] }));
		}
		const failed = rejected.map(c => c.f.provider.label);
		const synced = await sync();
		const failure = failed.length ? ` Not imported, because the provider rejected the key: ${failed.join(", ")}.` : "";
		setNotice({ kind: failed.length ? "warn" : synced.kind, text: `Imported ${plural(usable.length, "key")}. ${synced.text}${failure}` });
		if (usable.length > 0) continueSetup();
	};

	const current = view.name === "provider" || view.name === "key" ? snapshot.providers.find(p => p.id === view.id) : undefined;

	if (view.name === "provider" && current) {
		return (
			<ProviderScreen
				key={current.id}
				provider={current}
				snapshot={snapshot}
				notice={notice}
				busy={busy}
				onOpenUrl={openUrl}
				onAddKey={() => {
					setNotice(null);
					setView({ name: "key", id: current.id });
				}}
				onRemoveKey={() => {
					removeKey(current.id);
					removeFromDroid(current);
					refresh();
					setNotice({ kind: "good", text: `Removed ${current.label}'s key and its models from Droid.` });
					setView({ name: "home" });
				}}
				onToggle={(modelId, available) => {
					// Read fresh so quick toggles build on each other.
					updateSettings(settings => toggleModel(settings, current, modelId, available));
					refresh();
				}}
				onBack={changed => {
					setNotice(null);
					setView({ name: "home" });
					if (changed && snapshot.keys[current.id]) void sync().then(setNotice);
				}}
			/>
		);
	}
	if (view.name === "key" && current) {
		return (
			<KeyEntry
				provider={current}
				onOpenUrl={openUrl}
				onCancel={() => setView({ name: "provider", id: current.id })}
				onSaved={async message => {
					refresh();
					setView({ name: "provider", id: current.id });
					const synced = await sync();
					setNotice(synced.kind === "bad" ? synced : { kind: message.kind, text: `${message.text} ${synced.text}` });
					continueSetup();
				}}
			/>
		);
	}
	if (view.name === "import") {
		return <ImportScreen found={found} onCancel={() => setView({ name: "home" })} onImport={chosen => void importKeys(chosen)} />;
	}
	if (view.name === "settings") {
		return (
			<SettingsScreen
				settings={snapshot.settings}
				scheduler={scheduler}
				onToggleSchedule={() => {
					if (scheduler.installed()) {
						scheduler.remove();
						return null;
					}
					return scheduler.install();
				}}
				onOfferHealth={settings => {
					writeSettings(settings);
					refresh();
					setView({ name: "offerHealth", duringSetup: false });
				}}
				onDone={(settings, changed) => {
					setView({ name: "home" });
					if (!changed) return;
					writeSettings(settings);
					refresh();
					void sync().then(setNotice);
				}}
			/>
		);
	}
	if (view.name === "cleanup") {
		return <CleanupScreen leftovers={snapshot.leftovers} staleRefs={snapshot.staleRefs} onSkip={keepLeftovers} onApply={chosen => void cleanUp(chosen)} />;
	}
	if (view.name === "offerHealth") {
		return (
			<OfferHealthCheck
				onAnswer={yes => {
					updateState(s => ({ ...s, healthAsked: true }));
					setView({ name: "home" });
					if (yes) {
						updateSettings(s => ({ ...s, healthCheck: true }));
						refresh();
						void sync().then(setNotice);
					}
					if (view.duringSetup) afterFirstKey();
				}}
			/>
		);
	}
	if (view.name === "offerSchedule") {
		return (
			<OfferSchedule
				onAnswer={yes => {
					const problem = yes ? scheduler.install() : null;
					if (problem) setNotice({ kind: "bad", text: `Couldn't turn on daily sync: ${problem}` });
					else if (yes) setNotice({ kind: "good", text: "Daily sync is on." });
					setView({ name: "home" });
				}}
			/>
		);
	}
	return (
		<Home
			snapshot={snapshot}
			found={found.length}
			notice={notice}
			busy={busy}
			onOpen={id => {
				setNotice(null);
				setView({ name: "provider", id });
			}}
			onSync={() => void sync().then(setNotice)}
			onImport={() => setView({ name: "import" })}
			onCleanup={() => setView({ name: "cleanup" })}
			onSettings={() => setView({ name: "settings" })}
			onQuit={exit}
		/>
	);
}

export async function startApp() {
	const instance = render(<App />, { alternateScreen: true });
	await instance.waitUntilExit();
}
