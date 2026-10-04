/**
 * Pi extension: scan MCP servers configured for `/mcp` and manage their events.
 *
 * Servers come from `~/.pi/agent/mcp.json`, `<project>/.pi/mcp.json` when the project is trusted,
 * and `pi.getMcpServers()`. HTTP auth follows pi: an Authorization header, a `/login` provider
 * token, or the OAuth tokens `/mcp` stored in `mcp-auth.json`. This extension does not start a
 * browser sign-in.
 *
 * Tools follow pi's MCP names: `mcp__<server>__events__<event>__<action>`.
 * Scan and status omit the event. Poll, stream, subscribe, and unsubscribe are
 * registered only for a delivery mode that event advertises.
 */

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { describeHttpAuth } from "./auth.ts";
import { type ServerScan, pollEvents, readEventStream, scanServer, serverConfigSummary, subscribeWebhook } from "./session.ts";
import { isHttpServer, loadServers, type DiscoveredServer } from "./servers.ts";
import { loadSubscriptions, parseSubscribeResult, removeSubscription, upsertSubscription, type SavedSubscription } from "./subscriptions.ts";
import { createEventToolName, eventToolSegment } from "./names.ts";
import { isWebhookSecret } from "./wire.ts";
import type { EventTypeInfo } from "./events.ts";

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
	const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const subscriptionPath = () => join(getAgentDir(), "mcp-events.json");
	let bound: { cwd: string; token: (provider: string) => Promise<string | undefined>; trusted: () => boolean } | undefined;

	function bind(ctx: { cwd: string; isProjectTrusted(): boolean; modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> } }): void {
		bound = { cwd: ctx.cwd, trusted: () => ctx.isProjectTrusted(), token: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider) };
	}

	async function refreshSubscription(sub: SavedSubscription): Promise<void> {
		if (!bound) return;
		const server = findServer(discover({ cwd: bound.cwd, isProjectTrusted: bound.trusted }).servers, sub.server);
		if (!server) return;
		const result = await subscribeWebhook(server, bound.cwd, getAgentDir(), bound.token, {
			name: sub.name,
			arguments: sub.arguments,
			url: sub.url,
			secret: sub.secret,
			cursor: sub.cursor,
		});
		const parsed = parseSubscribeResult(result);
		remember({ ...sub, cursor: parsed.cursor, ...(parsed.id ? { id: parsed.id } : {}), refreshBefore: parsed.refreshBefore });
	}

	function remember(sub: SavedSubscription): void {
		upsertSubscription(subscriptionPath(), sub);
		const key = `${sub.server}\n${sub.name}\n${sub.url}`;
		const existing = refreshTimers.get(key);
		if (existing) clearTimeout(existing);
		if (!sub.refreshBefore) return;
		const delay = Math.max(1_000, Date.parse(sub.refreshBefore) - 60_000 - Date.now());
		if (!Number.isFinite(delay)) return;
		const timer = setTimeout(() => {
			void refreshSubscription(sub).catch(() => undefined);
		}, delay);
		timer.unref?.();
		refreshTimers.set(key, timer);
	}

	function discover(ctx: { cwd: string; isProjectTrusted(): boolean }): { servers: DiscoveredServer[]; errors: string[] } {
		const loaded = loadServers({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			registered: (typeof pi.getMcpServers === "function" ? pi.getMcpServers() : []).map((server) => ({ name: server.name, config: server.config })),
			agentDirectory: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
		});
		return { servers: [...loaded.servers.values()], errors: loaded.errors };
	}

	async function providerToken(ctx: { modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> } }, provider: string) {
		return ctx.modelRegistry.getApiKeyForProvider(provider);
	}

	const registeredNames = new Set<string>();
	const namesByKey = new Map<string, string>();

	function toolName(serverName: string, action: "scan" | "status" | "poll" | "stream" | "subscribe" | "unsubscribe", eventName?: string): string {
		const key = `${serverName}\0${action}\0${eventName ?? ""}`;
		const existing = namesByKey.get(key);
		if (existing) return existing;
		const name = createEventToolName(serverName, eventToolSegment(action, eventName), (candidate) => registeredNames.has(candidate));
		namesByKey.set(key, name);
		return name;
	}

	function register(definition: Parameters<ExtensionAPI["registerTool"]>[0]): void {
		if (registeredNames.has(definition.name)) return;
		registeredNames.add(definition.name);
		pi.registerTool(definition);
	}

	function namespaceFor(server: DiscoveredServer) {
		return {
			name: `mcp__${server.name.replace(/[^A-Za-z0-9_]/g, "_")}`,
			...(server.config.description ? { description: server.config.description } : {}),
		};
	}

	function registerEventTools(server: DiscoveredServer, event: EventTypeInfo): void {
		const about = event.description ? `${event.description} ` : "";
		const namespace = namespaceFor(server);
		if (event.delivery.includes("poll")) {
			register({
				name: toolName(server.name, "poll", event.name),
				label: `${server.name} ${event.name} poll`,
				description: `${about}Poll event ${event.name} on MCP server ${server.name} (events/poll). Direct tool. cursor null starts from now. Call again immediately when hasMore is true, otherwise after nextPollMs.`,
				promptSnippet: `Poll ${event.name} on ${server.name}`,
				exposure: "direct",
				namespace,
				parameters: Type.Object({
					arguments: argumentsSchema,
					cursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
					maxEvents: Type.Optional(Type.Integer({ minimum: 1 })),
					maxAgeMs: Type.Optional(Type.Integer({ minimum: 0 })),
				}),
				async execute(_id, params, signal, _onUpdate, ctx) {
					bind(ctx);
					try {
						return text(await pollEvents(server, ctx.cwd, getAgentDir(), (provider) => providerToken(ctx, provider), { name: event.name, ...params }, signal));
					} catch (error) {
						return text(error instanceof Error ? error.message : String(error), true);
					}
				},
			});
		}
		if (event.delivery.includes("push")) {
			register({
				name: toolName(server.name, "stream", event.name),
				label: `${server.name} ${event.name} stream`,
				description: `${about}Read the push stream for event ${event.name} on MCP server ${server.name} (events/stream). Direct tool. Wait for maxEvents events, default 1, with no time limit. Do not pass waitMs unless the user asked for a time limit. Heartbeats advance the cursor.`,
				promptSnippet: `Wait for one ${event.name} event on ${server.name}. Do not set a time limit unless asked.`,
				exposure: "direct",
				namespace,
				parameters: Type.Object({
					arguments: argumentsSchema,
					cursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
					maxAgeMs: Type.Optional(Type.Integer({ minimum: 0 })),
					maxEvents: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
					waitMs: Type.Optional(Type.Integer({ minimum: 0 })),
				}),
				async execute(_id, params, signal, _onUpdate, ctx) {
					bind(ctx);
					try {
						return text(
							await readEventStream(
								server,
								ctx.cwd,
								getAgentDir(),
								(provider) => providerToken(ctx, provider),
								{ name: event.name, ...params, maxEvents: params.maxEvents ?? 1 },
								signal,
							),
						);
					} catch (error) {
						return text(error instanceof Error ? error.message : String(error), true);
					}
				},
			});
		}
		if (event.delivery.includes("webhook")) {
			register({
				name: toolName(server.name, "subscribe", event.name),
				label: `${server.name} ${event.name} subscribe`,
				description: `${about}Subscribe to webhook delivery for event ${event.name} on MCP server ${server.name} (events/subscribe). Direct tool. The secret must be whsec_ plus base64 of 24 to 64 random bytes. The same arguments and url refresh the subscription. This process does not receive the webhook.`,
				promptSnippet: `Subscribe to ${event.name} webhooks on ${server.name}`,
				exposure: "direct",
				namespace,
				parameters: Type.Object({
					arguments: argumentsSchema,
					url: Type.String({ description: "https callback URL" }),
					secret: Type.String({ description: "whsec_ signing secret" }),
					cursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
					ttlMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
				}),
				async execute(_id, params, signal, _onUpdate, ctx) {
					bind(ctx);
					if (!params.url.startsWith("https://")) return text("Webhook url must be https.", true);
					if (!isWebhookSecret(params.secret)) return text("secret must be whsec_ plus base64 of 24 to 64 bytes.", true);
					try {
						const result = await subscribeWebhook(
							server,
							ctx.cwd,
							getAgentDir(),
							(provider) => providerToken(ctx, provider),
							{ name: event.name, ...params },
							signal,
						);
						const parsed = parseSubscribeResult(result);
						remember({
							server: server.name,
							name: event.name,
							arguments: params.arguments ?? {},
							url: params.url,
							secret: params.secret,
							cursor: parsed.cursor,
							...(parsed.id ? { id: parsed.id } : {}),
							refreshBefore: parsed.refreshBefore,
						});
						return text(result);
					} catch (error) {
						return text(error instanceof Error ? error.message : String(error), true);
					}
				},
			});
			register({
				name: toolName(server.name, "unsubscribe", event.name),
				label: `${server.name} ${event.name} unsubscribe`,
				description: `${about}Stop the webhook subscription for event ${event.name} on MCP server ${server.name} (events/unsubscribe). Direct tool. Pass the same arguments and url used to subscribe.`,
				promptSnippet: `Unsubscribe from ${event.name} webhooks on ${server.name}`,
				exposure: "direct",
				namespace,
				parameters: Type.Object({
					arguments: argumentsSchema,
					url: Type.String(),
				}),
				async execute(_id, params, signal, _onUpdate, ctx) {
					bind(ctx);
					try {
						const result = await subscribeWebhook(
							server,
							ctx.cwd,
							getAgentDir(),
							(provider) => providerToken(ctx, provider),
							{ name: event.name, ...params, secret: "", unsubscribe: true },
							signal,
						);
						removeSubscription(subscriptionPath(), { server: server.name, name: event.name, arguments: params.arguments ?? {}, url: params.url });
						const timer = refreshTimers.get(`${server.name}\n${event.name}\n${params.url}`);
						if (timer) clearTimeout(timer);
						return text(result ?? { ok: true });
					} catch (error) {
						return text(error instanceof Error ? error.message : String(error), true);
					}
				},
			});
		}
	}

	function registerServerTools(ctx: { cwd: string; isProjectTrusted(): boolean }): void {
		for (const server of discover(ctx).servers) {
			if (!server.enabled) continue;
			const namespace = namespaceFor(server);
			register({
				name: toolName(server.name, "status"),
				label: `${server.name} events status`,
				description: `Show how MCP server ${server.name} authenticates and which event types the last scan found. Direct tool. Does not connect.`,
				promptSnippet: `Show event status for ${server.name}`,
				exposure: "direct",
				namespace,
				parameters: Type.Object({}),
				async execute(_id, _params, _signal, _onUpdate, callCtx) {
					bind(callCtx);
					const current = discover(callCtx).servers.find((entry) => entry.name === server.name);
					const events = catalog?.servers.find((entry) => entry.server === server.name)?.events ?? [];
					return text({
						server: server.name,
						enabled: current?.enabled ?? false,
						target: serverConfigSummary(server.config),
						auth: isHttpServer(server.config) ? describeHttpAuth(server.name, server.config, join(getAgentDir(), "mcp-auth.json")) : { mode: "none" },
						scannedAt: catalog?.scannedAt ?? null,
						events: events.map((event) => ({ name: event.name, delivery: event.delivery })),
					});
				},
			});
			register({
				name: toolName(server.name, "scan"),
				label: `${server.name} events scan`,
				description: `Connect to MCP server ${server.name} and list its event types (events/list). Direct tool. Registers mcp__${server.name}__events__<event>__<action> for each advertised delivery mode.`,
				promptSnippet: `Scan ${server.name} for MCP event types`,
				exposure: "direct",
				namespace,
				parameters: Type.Object({}),
				async execute(_id, _params, signal, _onUpdate, callCtx) {
					bind(callCtx);
					const current = findServer(discover(callCtx).servers, server.name);
					if (!current) return text(`MCP server "${server.name}" is not enabled.`, true);
					try {
						const result = await scanServer(current, callCtx.cwd, getAgentDir(), (provider) => providerToken(callCtx, provider), signal);
						catalog = {
							scannedAt: new Date().toISOString(),
							servers: [...(catalog?.servers.filter((entry) => entry.server !== server.name) ?? []), result],
						};
						for (const event of result.events ?? []) registerEventTools(current, event);
						return text({ ...result, tools: [...registeredNames].filter((name) => name.startsWith(`mcp__${server.name.replace(/[^A-Za-z0-9_]/g, "_")}__events__`)) });
					} catch (error) {
						return text(error instanceof Error ? error.message : String(error), true);
					}
				},
			});
		}
	}

	pi.on("session_start", (_event, ctx) => {
		bind(ctx);
		registerServerTools(ctx);
		for (const sub of loadSubscriptions(subscriptionPath())) remember(sub);
	});
}
