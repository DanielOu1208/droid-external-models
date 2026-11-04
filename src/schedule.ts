// Keeps models current in the background, using launchd on macOS.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { selfArgs } from "./self";
import { home } from "./store";

const LABEL = "com.droid-models.sync";
const plistPath = () => join(home(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const logPath = () => join(home(), "Library", "Logs", "droid-models.log");
const domain = () => `gui/${process.getuid?.()}`;

export interface Scheduler {
	supported: boolean;
	installed(): boolean;
	install(): string | null;
	remove(): void;
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const launchdScheduler: Scheduler = {
	supported: process.platform === "darwin",
	installed: () => existsSync(plistPath()),
	// Returns an error message if the job couldn't start.
	install() {
		Bun.spawnSync(["launchctl", "bootout", `${domain()}/${LABEL}`], { stdout: "ignore", stderr: "ignore" });
		const args = [...selfArgs(), "sync"].map(arg => `\t\t<string>${escapeXml(arg)}</string>`).join("\n");
		const log = escapeXml(logPath());
		const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${args}
	</array>
	<key>RunAtLoad</key><true/>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key><integer>9</integer>
		<key>Minute</key><integer>0</integer>
	</dict>
	<key>StandardOutPath</key><string>${log}</string>
	<key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
		mkdirSync(dirname(plistPath()), { recursive: true });
		writeFileSync(plistPath(), plist);
		const result = Bun.spawnSync(["launchctl", "bootstrap", domain(), plistPath()], { stdout: "ignore", stderr: "pipe" });
		return result.exitCode === 0 ? null : result.stderr.toString().trim();
	},
	remove() {
		Bun.spawnSync(["launchctl", "bootout", `${domain()}/${LABEL}`], { stdout: "ignore", stderr: "ignore" });
		rmSync(plistPath(), { force: true });
	},
};
