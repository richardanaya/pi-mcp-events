import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { McpError, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { resolveAuth } from "./auth.ts";
import { type EventOccurrence, listEventTypes, parseEventOccurrence } from "./events.ts";
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PollResult {
	events: EventOccurrence[];
	cursor: string | null;
	truncated: boolean;
	hasMore: boolean;
	nextPollMs?: number;
}

/** One `events/poll`. The caller repeats it: immediately when `hasMore` is true, otherwise after `nextPollMs`. */
export async function pollEvents(
	server: DiscoveredServer,
	cwd: string,
	agentDirectory: string,
	providerToken: (provider: string) => Promise<string | undefined>,
	params: { name: string; arguments?: Record<string, unknown>; cursor?: string | null; maxEvents?: number; maxAgeMs?: number },
	signal?: AbortSignal,
): Promise<PollResult> {
	const opened = await openServer(server, cwd, agentDirectory, providerToken, signal);
	try {
		const result = await opened.session.request(
			"events/poll",
			{
				name: params.name,
				...(params.arguments ? { arguments: params.arguments } : {}),
				cursor: params.cursor ?? null,
				...(params.maxEvents === undefined ? {} : { maxEvents: params.maxEvents }),
				...(params.maxAgeMs === undefined ? {} : { maxAgeMs: params.maxAgeMs }),
			},
			{ signal, timeoutMs: (server.config.timeout ?? 60) * 1000 },
		);
		if (!isRecord(result) || !Array.isArray(result.events)) throw new Error("Invalid events/poll result");
		const events: EventOccurrence[] = [];
		for (const entry of result.events) {
			const parsed = parseEventOccurrence(entry);
			if (!parsed) throw new Error("Invalid event in events/poll");
			events.push(parsed);
		}
		const cursor = result.cursor === null || result.cursor === undefined ? null : result.cursor;
		if (cursor !== null && typeof cursor !== "string") throw new Error("Invalid events/poll cursor");
		return {
			events,
			cursor,
			truncated: result.truncated === true,
			hasMore: result.hasMore === true,
			...(typeof result.nextPollMs === "number" ? { nextPollMs: result.nextPollMs } : {}),
		};
	} finally {
		await opened.close();
	}
}

/** Read one `events/stream` until `waitMs`, `maxEvents`, or abort, then cancel it. Heartbeats advance the cursor. */
export async function readEventStream(
	server: DiscoveredServer,
	cwd: string,
	agentDirectory: string,
	providerToken: (provider: string) => Promise<string | undefined>,
	params: { name: string; arguments?: Record<string, unknown>; cursor?: string | null; maxAgeMs?: number; maxEvents: number; waitMs: number },
	signal?: AbortSignal,
): Promise<{ events: EventOccurrence[]; cursor: string | null; truncated: boolean }> {
	const opened = await openServer(server, cwd, agentDirectory, providerToken, signal);
	const events: EventOccurrence[] = [];
	let cursor: string | null = params.cursor ?? null;
	let truncated = false;
	const stop = new AbortController();
	const onAbort = () => stop.abort();
	signal?.addEventListener("abort", onAbort);
	const timer = setTimeout(() => stop.abort(), params.waitMs);
	const takeCursor = (payload: unknown) => {
		if (!isRecord(payload)) return;
		if (typeof payload.cursor === "string") cursor = payload.cursor;
		else if (payload.cursor === null) cursor = null;
	};
	const offEvent = opened.session.onNotification("notifications/events/event", (payload) => {
		const parsed = parseEventOccurrence(payload);
		if (!parsed) return;
		events.push(parsed);
		if (parsed.cursor !== undefined) cursor = parsed.cursor ?? null;
		if (events.length >= params.maxEvents) stop.abort();
	});
	const offActive = opened.session.onNotification("notifications/events/active", (payload) => {
		takeCursor(payload);
		if (isRecord(payload) && payload.truncated === true) truncated = true;
	});
	const offHeartbeat = opened.session.onNotification("notifications/events/heartbeat", takeCursor);
	try {
		const pending = opened.session.request(
			"events/stream",
			{
				name: params.name,
				...(params.arguments ? { arguments: params.arguments } : {}),
				cursor: params.cursor ?? null,
				...(params.maxAgeMs === undefined ? {} : { maxAgeMs: params.maxAgeMs }),
			},
			{ signal: stop.signal, timeoutMs: params.waitMs + 5_000 },
		);
		try {
			await pending;
		} catch (error) {
			if (!stop.signal.aborted && !signal?.aborted) throw error;
		}
		return { events, cursor, truncated };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		offEvent();
		offActive();
		offHeartbeat();
		await opened.close();
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
