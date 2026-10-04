import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface HttpServerConfig {
	url: string;
	headers?: Record<string, string>;
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		scope?: string;
		clientName?: string;
	};
	auth?: { provider: string };
	timeout?: number;
	enabled?: boolean;
	description?: string;
}

export interface StdioServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	timeout?: number;
	enabled?: boolean;
	description?: string;
}

export type ServerConfig = HttpServerConfig | StdioServerConfig;

export interface DiscoveredServer {
	name: string;
	config: ServerConfig;
	source: "global" | "project" | "extension";
	enabled: boolean;
}

export function isHttpServer(config: ServerConfig): config is HttpServerConfig {
	return "url" in config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value);
	if (!entries.every(([, entry]) => typeof entry === "string")) return undefined;
	return Object.fromEntries(entries);
}

function readTimeout(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Parse one `mcpServers` entry. Returns an error string when the entry is not a server. */
export function parseServerConfig(name: string, value: unknown): ServerConfig | string {
	if (!/^[A-Za-z0-9_-]+$/.test(name)) return `server "${name}" must match [A-Za-z0-9_-]+`;
	if (!isRecord(value)) return `server "${name}" must be an object`;
	const shared = {
		...(typeof value.description === "string" ? { description: value.description } : {}),
		...(readTimeout(value.timeout) === undefined ? {} : { timeout: readTimeout(value.timeout) }),
		...(value.enabled === false ? { enabled: false as const } : {}),
	};
	if (typeof value.url === "string" && value.url.trim()) {
		const headers = value.headers === undefined ? undefined : stringRecord(value.headers);
		if (value.headers !== undefined && !headers) return `server "${name}" headers must be strings`;
		let oauth: HttpServerConfig["oauth"];
		if (value.oauth !== undefined) {
			if (!isRecord(value.oauth)) return `server "${name}" oauth must be an object`;
			oauth = {
				...(typeof value.oauth.clientId === "string" ? { clientId: value.oauth.clientId } : {}),
				...(typeof value.oauth.clientSecret === "string" ? { clientSecret: value.oauth.clientSecret } : {}),
				...(typeof value.oauth.scope === "string" ? { scope: value.oauth.scope } : {}),
				...(typeof value.oauth.clientName === "string" ? { clientName: value.oauth.clientName } : {}),
			};
		}
		let auth: HttpServerConfig["auth"];
		if (value.auth !== undefined) {
			if (!isRecord(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider.trim()) {
				return `server "${name}" auth.provider must be a string`;
			}
			auth = { provider: value.auth.provider };
		}
		return { url: value.url, ...(headers ? { headers } : {}), ...(oauth ? { oauth } : {}), ...(auth ? { auth } : {}), ...shared };
	}
	if (typeof value.command === "string" && value.command.trim()) {
		if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))) {
			return `server "${name}" args must be strings`;
		}
		const env = value.env === undefined ? undefined : stringRecord(value.env);
		if (value.env !== undefined && !env) return `server "${name}" env must be strings`;
		return {
			command: value.command,
			...(Array.isArray(value.args) ? { args: value.args as string[] } : {}),
			...(env ? { env } : {}),
			...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
			...shared,
		};
	}
	return `server "${name}" needs "command" or "url"`;
}

function isOverride(value: Record<string, unknown>): boolean {
	return value.command === undefined && value.url === undefined && value.type === undefined;
}

export interface ConfigLoad {
	servers: Map<string, DiscoveredServer>;
	errors: string[];
}

function readFile(path: string, scope: "global" | "project", state: ConfigLoad): void {
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		state.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		state.errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		if (scope === "project" && isRecord(value) && isOverride(value)) {
			const base = state.servers.get(name);
			if (!base || base.source !== "global") {
				state.errors.push(`${path}: server "${name}" needs "command" or "url", or a global server to override`);
				continue;
			}
			const enabled = value.enabled === undefined ? base.enabled : value.enabled === true;
			if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
				state.errors.push(`${path}: server "${name}" enabled must be a boolean`);
				continue;
			}
			state.servers.set(name, { ...base, enabled, config: { ...base.config, ...(value.enabled === false ? { enabled: false } : { enabled: true }) } });
			continue;
		}
		const config = parseServerConfig(name, value);
		if (typeof config === "string") {
			state.errors.push(`${path}: ${config}`);
			continue;
		}
		state.servers.set(name, { name, config, source: scope, enabled: config.enabled !== false });
	}
}

export interface RegisteredServer {
	name: string;
	config: { command?: string; url?: string; args?: string[]; headers?: Record<string, string>; env?: Record<string, string>; cwd?: string; auth?: { provider: string }; timeout?: number; enabled?: boolean; description?: string };
}

/**
 * Servers `/mcp` shows: global `mcp.json`, then the trusted project's `.pi/mcp.json`, then
 * `pi.registerMcpServer()` entries that do not reuse a file name. File entries win.
 */
export function loadServers(options: {
	cwd: string;
	projectTrusted: boolean;
	registered: readonly RegisteredServer[];
	/** `getAgentDir()` from `@earendil-works/pi-coding-agent`. */
	agentDirectory: string;
	/** `CONFIG_DIR_NAME` from the same package. Project MCP config is `<cwd>/<configDirName>/mcp.json`. */
	configDirName: string;
}): ConfigLoad {
	const state: ConfigLoad = { servers: new Map(), errors: [] };
	readFile(join(options.agentDirectory, "mcp.json"), "global", state);
	if (options.projectTrusted) readFile(join(options.cwd, options.configDirName, "mcp.json"), "project", state);
	for (const server of options.registered) {
		if (state.servers.has(server.name)) continue;
		const config = parseServerConfig(server.name, server.config);
		if (typeof config === "string") {
			state.errors.push(`extension: ${config}`);
			continue;
		}
		state.servers.set(server.name, { name: server.name, config, source: "extension", enabled: config.enabled !== false });
	}
	return state;
}

/** Replace `${NAME}` with the process environment. Leaves other text unchanged. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
		const found = env[name];
		if (found === undefined) throw new Error(`environment variable ${name} is not set`);
		return found;
	});
}
