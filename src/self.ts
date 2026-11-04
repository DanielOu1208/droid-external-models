import { join } from "node:path";

// A compiled binary runs from Bun's virtual filesystem.
const compiled = import.meta.path.startsWith("/$bunfs/");

export const selfArgs = (): string[] => (compiled ? [process.execPath] : [process.execPath, join(import.meta.dir, "cli.ts")]);

const shellQuote = (arg: string) => (/^[\w./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

// The command Droid runs to get a provider's key.
export const helperCommand = (providerId: string, startFixer = false) => [...selfArgs(), "key", providerId, ...(startFixer ? ["--start-fixer"] : [])].map(shellQuote).join(" ");
