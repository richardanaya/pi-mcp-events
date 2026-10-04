import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { McpError, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { resolveAuth } from "./auth.ts";
import { listEventTypes } from "./events.ts";
import { EventSession } from "./wire.ts";
import { expandEnv, isHttpServer, type DiscoveredServer, type ServerConfig } from "./servers.ts";

export interface ServerScan {
	server: string;
	source: DiscoveredServer["source"];
	auth: string;
	events?: EventTypeInfo[];
	error?: string;
}

function authLabel(mode: { mode: string; provider?: string }): string {
	return mode.mode === "provider" && mode.provider ? `provider:${mode.provider}` : mode.mode;
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	return value;
}

async function openServer(
	server: DiscoveredServer,
	cwd: string,
	agentDirectory: string,
	providerToken: (provider: string) => Promise<string | undefined>,
	signal?: AbortSignal,
): Promise<{ session: EventSession; auth: string; close: () => Promise<void> }> {
	const resolved = await resolveAuth(server.name, server.config, providerToken, join(agentDirectory, "mcp-auth.json"));
	if (resolved.mode.mode === "needs-sign-in") {
		throw new Error(`MCP server "${server.name}" requires sign-in. Run /mcp to sign in.`);
	}
	if (resolved.mode.mode === "provider" && !resolved.headers?.Authorization) {
		throw new Error(`MCP server "${server.name}" has no token for /login provider "${resolved.mode.provider}".`);
	}
	const transport = isHttpServer(server.config)
		? new StreamableHttpTransport({
				url: server.config.url,
				...(resolved.headers ? { headers: resolved.headers } : {}),
				...(resolved.authProvider ? { authProvider: resolved.authProvider } : {}),
			})
		: new StdioTransport({
				command: expandHome(expandEnv(server.config.command)),
				args: server.config.args?.map((arg) => expandHome(expandEnv(arg))),
				cwd: resolve(cwd, expandHome(server.config.cwd ?? ".")),
				...(resolved.env ? { env: resolved.env } : {}),
				stderr: "pipe",
			});
	const session = await EventSession.open(transport, signal);
	if (signal?.aborted) {
		await session.close();
		throw new Error("aborted");
	}
	return { session, auth: authLabel(resolved.mode), close: () => session.close() };
}

export async function scanServer(
	server: DiscoveredServer,
	cwd: string,
	agentDirectory: string,
	providerToken: (provider: string) => Promise<string | undefined>,
	signal?: AbortSignal,
): Promise<ServerScan> {
	if (!server.enabled) return { server: server.name, source: server.source, auth: "disabled" };
	try {
		const opened = await openServer(server, cwd, agentDirectory, providerToken, signal);
		try {
			const events = await listEventTypes(opened.session, signal);
			return { server: server.name, source: server.source, auth: opened.auth, events };
		} finally {
			await opened.close();
		}
	} catch (error) {
		return {
			server: server.name,
			source: server.source,
			auth: "unknown",
			error: error instanceof McpError ? error.message : error instanceof Error ? error.message : String(error),
		};
	}
}

export async function subscribeWebhook(
	server: DiscoveredServer,
	cwd: string,
	agentDirectory: string,
	providerToken: (provider: string) => Promise<string | undefined>,
	params: {
		name: string;
		arguments?: Record<string, unknown>;
		url: string;
		secret: string;
		cursor?: string | null;
		ttlMs?: number | null;
		unsubscribe?: boolean;
	},
	signal?: AbortSignal,
): Promise<unknown> {
	const opened = await openServer(server, cwd, agentDirectory, providerToken, signal);
	try {
		if (params.unsubscribe) {
			return await opened.session.request(
				"events/unsubscribe",
				{
					name: params.name,
					...(params.arguments ? { arguments: params.arguments } : {}),
					delivery: { mode: "webhook", url: params.url },
				},
				{ signal },
			);
		}
		return await opened.session.request(
			"events/subscribe",
			{
				name: params.name,
				...(params.arguments ? { arguments: params.arguments } : {}),
				delivery: { mode: "webhook", url: params.url, secret: params.secret },
				cursor: params.cursor ?? null,
				...(params.ttlMs === undefined ? {} : { ttlMs: params.ttlMs }),
			},
			{ signal },
		);
	} finally {
		await opened.close();
	}
}

export function serverConfigSummary(config: ServerConfig): string {
	return isHttpServer(config) ? config.url : config.command;
}
