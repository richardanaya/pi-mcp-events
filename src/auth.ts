import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import { adaptOAuthProvider, McpOAuthProvider, type McpOAuthState, type McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { expandEnv, type HttpServerConfig } from "./servers.ts";

/** Key pi writes in `mcp-auth.json`: `mcp__<name>|url`, with `-` in the name turned into `_`. */
export function mcpAuthKey(name: string, serverUrl: string): string {
	const url = String(new URL(serverUrl));
	return `mcp__${name.replace(/-/g, "_")}|${url}`;
}

type AuthFile = Record<string, McpOAuthState>;

export function readAuthFile(path: string): AuthFile {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed as AuthFile;
	} catch {
		return {};
	}
}

/** Read and write one server's entry in pi's `mcp-auth.json`, so a refresh updates the same tokens `/mcp` uses. */
export function fileOAuthStore(name: string, serverUrl: string, path: string): McpOAuthStateStore & {
	path: string;
	key: string;
} {
	const key = mcpAuthKey(name, serverUrl);
	return {
		path,
		key,
		load: () => readAuthFile(path)[key],
		save: (state) => {
			const current = readAuthFile(path);
			current[key] = state;
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
		},
	};
}

export type AuthMode =
	| { mode: "none" }
	| { mode: "header" }
	| { mode: "provider"; provider: string }
	| { mode: "oauth" }
	| { mode: "needs-sign-in" };

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
	return Object.keys(headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

/** How this HTTP server authenticates, without revealing secrets. */
export function describeHttpAuth(name: string, config: HttpServerConfig, authPath: string): AuthMode {
	if (config.auth?.provider) return { mode: "provider", provider: config.auth.provider };
	if (hasAuthorizationHeader(config.headers)) return { mode: "header" };
	const store = fileOAuthStore(name, config.url, authPath);
	const state = store.load();
	const tokens = state instanceof Promise ? undefined : state?.tokens?.access_token;
	return tokens ? { mode: "oauth" } : { mode: "needs-sign-in" };
}

export interface ResolvedAuth {
	mode: AuthMode;
	headers?: Record<string, string>;
	authProvider?: AuthProvider;
	env?: Record<string, string>;
}

export async function resolveAuth(
	name: string,
	config: HttpServerConfig | { command: string; env?: Record<string, string> },
	providerToken: (provider: string) => Promise<string | undefined>,
	authPath: string,
): Promise<ResolvedAuth> {
	if (!("url" in config)) {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(config.env ?? {})) env[key] = expandEnv(value);
		return { mode: { mode: "none" }, ...(Object.keys(env).length > 0 ? { env } : {}) };
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.headers ?? {})) headers[key] = expandEnv(value);
	if (config.auth?.provider) {
		const token = await providerToken(config.auth.provider);
		if (!token) return { mode: { mode: "provider", provider: config.auth.provider } };
		headers.Authorization = `Bearer ${token}`;
		return { mode: { mode: "provider", provider: config.auth.provider }, headers };
	}
	if (hasAuthorizationHeader(headers)) return { mode: { mode: "header" }, headers };
	const store = fileOAuthStore(name, config.url, authPath);
	const loaded = await store.load();
	if (!loaded?.tokens?.access_token) return { mode: { mode: "needs-sign-in" } };
	const oauth = new McpOAuthProvider({
		serverUrl: config.url,
		redirectUrl: "http://127.0.0.1/callback",
		clientMetadata: { client_name: config.oauth?.clientName ?? "pi" },
		...(config.oauth?.clientId ? { clientId: config.oauth.clientId } : {}),
		...(config.oauth?.clientSecret ? { clientSecret: expandEnv(config.oauth.clientSecret) } : {}),
		store,
		onRedirect: () => {
			throw new Error(`MCP server "${name}" needs sign-in. Run /mcp to sign in.`);
		},
	});
	return { mode: { mode: "oauth" }, ...(Object.keys(headers).length > 0 ? { headers } : {}), authProvider: adaptOAuthProvider(oauth) };
}
