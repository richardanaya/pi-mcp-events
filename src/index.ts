/**
 * Pi extension: scan MCP servers configured for `/mcp` and manage their events.
 *
 * Servers come from `~/.pi/agent/mcp.json`, `<project>/.pi/mcp.json` when the project is trusted,
 * and `pi.getMcpServers()`. HTTP auth follows pi: an Authorization header, a `/login` provider
 * token, or the OAuth tokens `/mcp` stored in `mcp-auth.json`. This extension does not start a
 * browser sign-in.
 *
 * Event types are not registered as one tool each. Five tools manage every server the same way:
 * scan, poll, read a bounded push stream, subscribe a webhook, and unsubscribe it.
 */

import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeHttpAuth } from "./auth.ts";
import { type ServerScan, pollEvents, readEventStream, scanServer, serverConfigSummary, subscribeWebhook } from "./session.ts";
import { isHttpServer, loadServers, type DiscoveredServer } from "./servers.ts";

interface Catalog {
	scannedAt: string;
	servers: ServerScan[];
}

const argumentsSchema = Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Subscription arguments for the event type's inputSchema" }));

function text(value: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
		details: {},
		...(isError ? { isError: true } : {}),
	};
}

function findServer(servers: DiscoveredServer[], name: string): DiscoveredServer | undefined {
	return servers.find((server) => server.name === name && server.enabled);
}

export default function mcpEventsExtension(pi: ExtensionAPI) {
	let catalog: Catalog | undefined;

	function discover(ctx: { cwd: string; isProjectTrusted(): boolean }): { servers: DiscoveredServer[]; errors: string[] } {
		const loaded = loadServers({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			registered: pi.getMcpServers().map((server) => ({ name: server.name, config: server.config })),
			agentDirectory: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
		});
		return { servers: [...loaded.servers.values()], errors: loaded.errors };
	}

	async function providerToken(ctx: { modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> } }, provider: string) {
		return ctx.modelRegistry.getApiKeyForProvider(provider);
	}

	async function scanAll(ctx: Parameters<typeof discover>[0] & { modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> }; signal?: AbortSignal }): Promise<Catalog> {
		const { servers } = discover(ctx);
		const token = (provider: string) => providerToken(ctx, provider);
		const results = await Promise.all(servers.map((server) => scanServer(server, ctx.cwd, getAgentDir(), token, ctx.signal)));
		catalog = { scannedAt: new Date().toISOString(), servers: results };
		return catalog;
	}

	pi.registerTool({
		name: "mcp_events_scan",
		label: "MCP events scan",
		description: "Connect to enabled MCP servers from /mcp, using their stored auth, and list event types (events/list). Servers without an events capability are listed with an empty event list.",
		promptSnippet: "Scan configured MCP servers for event types.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const { errors } = discover(ctx);
			const scanned = await scanAll({ ...ctx, signal });
			const types = scanned.servers.reduce((count, server) => count + (server.events?.length ?? 0), 0);
			return text({ errors, types, ...scanned });
		},
	});

	pi.registerTool({
		name: "mcp_events_status",
		label: "MCP events status",
		description: "Show configured MCP servers, how each one authenticates, and the event types from the last scan. Does not connect.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const { servers, errors } = discover(ctx);
			const rows = servers.map((server) => ({
				name: server.name,
				source: server.source,
				enabled: server.enabled,
				target: serverConfigSummary(server.config),
				auth: isHttpServer(server.config) ? describeHttpAuth(server.name, server.config, join(getAgentDir(), "mcp-auth.json")) : { mode: "none" as const },
				events: catalog?.servers.find((entry) => entry.server === server.name)?.events?.map((event) => event.name) ?? [],
			}));
			return text({ errors, scannedAt: catalog?.scannedAt ?? null, servers: rows });
		},
	});

	pi.registerTool({
		name: "mcp_events_poll",
		label: "MCP events poll",
		description: "Poll one event subscription (events/poll). cursor null starts from now. Pass the cursor from the previous result to continue. This is one subscription per call.",
		parameters: Type.Object({
			server: Type.String({ description: "MCP server name" }),
			name: Type.String({ description: "Event type name from mcp_events_scan" }),
			arguments: argumentsSchema,
			cursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			maxEvents: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
			maxAgeMs: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const server = findServer(discover(ctx).servers, params.server);
			if (!server) return text(`No enabled MCP server "${params.server}".`, true);
			try {
				const result = await pollEvents(server, ctx.cwd, getAgentDir(), (provider) => providerToken(ctx, provider), params, signal);
				return text(result);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	});

	pi.registerTool({
		name: "mcp_events_stream",
		label: "MCP events stream",
		description: "Open one events/stream subscription and return the events that arrive within waitMs, or until maxEvents. Then the stream is closed. cursor null starts from now.",
		parameters: Type.Object({
			server: Type.String(),
			name: Type.String(),
			arguments: argumentsSchema,
			cursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			maxAgeMs: Type.Optional(Type.Integer({ minimum: 0 })),
			maxEvents: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 20 })),
			waitMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000, default: 15000 })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const server = findServer(discover(ctx).servers, params.server);
			if (!server) return text(`No enabled MCP server "${params.server}".`, true);
			try {
				const result = await readEventStream(
					server,
					ctx.cwd,
					getAgentDir(),
					(provider) => providerToken(ctx, provider),
					{ ...params, maxEvents: params.maxEvents ?? 20, waitMs: params.waitMs ?? 15000 },
					signal,
				);
				return text(result);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	});

	pi.registerTool({
		name: "mcp_events_subscribe",
		label: "MCP events subscribe",
		description: "Register or refresh a webhook subscription (events/subscribe). The secret must be whsec_ plus base64 of 24 to 64 random bytes. Calling again with the same server, event name, arguments, and url refreshes the TTL. This extension does not receive the webhook; the url does.",
		parameters: Type.Object({
			server: Type.String(),
			name: Type.String(),
			arguments: argumentsSchema,
			url: Type.String({ description: "https callback URL" }),
			secret: Type.String({ description: "whsec_ signing secret" }),
			cursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			ttlMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const server = findServer(discover(ctx).servers, params.server);
			if (!server) return text(`No enabled MCP server "${params.server}".`, true);
			if (!params.url.startsWith("https://")) return text("Webhook url must be https.", true);
			if (!/^whsec_[A-Za-z0-9+/=]+$/.test(params.secret)) return text("secret must be a whsec_ value.", true);
			try {
				const result = await subscribeWebhook(server, ctx.cwd, getAgentDir(), (provider) => providerToken(ctx, provider), params, signal);
				return text(result);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	});

	pi.registerTool({
		name: "mcp_events_unsubscribe",
		label: "MCP events unsubscribe",
		description: "Stop a webhook subscription (events/unsubscribe) for the same server, event name, arguments, and callback url passed to mcp_events_subscribe.",
		parameters: Type.Object({
			server: Type.String(),
			name: Type.String(),
			arguments: argumentsSchema,
			url: Type.String(),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const server = findServer(discover(ctx).servers, params.server);
			if (!server) return text(`No enabled MCP server "${params.server}".`, true);
			try {
				const result = await subscribeWebhook(
					server,
					ctx.cwd,
					getAgentDir(),
					(provider) => providerToken(ctx, provider),
					{ ...params, secret: "", unsubscribe: true },
					signal,
				);
				return text(result ?? { ok: true });
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	});

}
