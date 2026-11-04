// Hosts aren't case-sensitive, but paths and queries can be: /tenant/A and /tenant/a may be different accounts.
export function sameEndpoint(a: unknown, b: unknown): boolean {
	const parse = (value: unknown) => {
		try {
			return new URL(String(value));
		} catch {
			return null;
		}
	};
	const [first, second] = [parse(a), parse(b)];
	if (!first || !second) return String(a ?? "") === String(b ?? "");
	const path = (url: URL) => url.pathname.replace(/\/+$/, "");
	return first.protocol === second.protocol && first.host === second.host && path(first) === path(second) && first.search === second.search;
}
