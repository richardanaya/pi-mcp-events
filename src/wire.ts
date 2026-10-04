import { createHmac, timingSafeEqual } from "node:crypto";
import {
	isJsonRpcNotification,
	isJsonRpcResponse,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
	McpError,
	type McpTransport,
} from "@earendil-works/pi-mcp";

/** Current MCP revision. Events in ChatGPT are defined on this version, not on `initialize`. */
export const PROTOCOL_VERSION = "2026-07-28";

const CLIENT_INFO = { name: "pi-mcp-events", version: "0.1.0" };

export function protocolMeta(): Record<string, unknown> {
	return {
		"io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
		"io.modelcontextprotocol/clientInfo": CLIENT_INFO,
		"io.modelcontextprotocol/clientCapabilities": {},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DiscoverResult {
	supportedVersions: string[];
	capabilities: Record<string, unknown>;
	serverInfo?: { name?: string; version?: string };
}

export function parseDiscoverResult(value: unknown): DiscoverResult {
	if (!isRecord(value) || !Array.isArray(value.supportedVersions) || !isRecord(value.capabilities)) {
		throw new Error("Invalid server/discover result");
	}
	const supportedVersions = value.supportedVersions.filter((version): version is string => typeof version === "string");
	if (!supportedVersions.includes(PROTOCOL_VERSION)) {
		throw new Error(`MCP server does not support protocol ${PROTOCOL_VERSION} (supported: ${supportedVersions.join(", ") || "none"})`);
	}
	const serverInfo = isRecord(value.serverInfo) ? { name: stringField(value.serverInfo.name), version: stringField(value.serverInfo.version) } : undefined;
	return { supportedVersions, capabilities: value.capabilities, ...(serverInfo ? { serverInfo } : {}) };
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	onAbort: () => void;
	signal?: AbortSignal;
}

interface RpcState {
	nextId: number;
	pending: Map<JsonRpcId, Pending>;
}

/**
 * One MCP connection that speaks `2026-07-28`: `server/discover` first, then every request carries
 * the protocol version in `_meta`. There is no `initialize` handshake.
 */
export class EventSession {
	readonly discover: DiscoverResult;
	private closed = false;

	private readonly transport: McpTransport;
	private readonly state: RpcState;
	private readonly stop: () => void;

	private constructor(transport: McpTransport, discover: DiscoverResult, state: RpcState, stop: () => void) {
		this.transport = transport;
		this.discover = discover;
		this.state = state;
		this.stop = stop;
	}

	static async open(transport: McpTransport, signal?: AbortSignal): Promise<EventSession> {
		await transport.start();
		transport.setProtocolVersion?.(PROTOCOL_VERSION);
		const state: RpcState = { nextId: 1, pending: new Map() };
		let settled = false;
		const stopMessage = transport.onMessage((message) => deliver(state, message));
		const stopClose = transport.onClose(() => failAll(state, new Error("MCP connection closed")));
		try {
			const result = parseDiscoverResult(await send(transport, state, "server/discover", {}, 30_000, signal));
			settled = true;
			return new EventSession(transport, result, state, () => {
				stopMessage();
				stopClose();
			});
		} finally {
			if (!settled) {
				stopMessage();
				stopClose();
				await transport.close();
			}
		}
	}

	onNotification(method: string, listener: (params: unknown) => void): () => void {
		return this.transport.onMessage((message) => {
			if (isJsonRpcNotification(message) && message.method === method) listener(message.params);
		});
	}

	request(method: string, params: Record<string, unknown> | undefined, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("MCP connection closed"));
		return send(this.transport, this.state, method, params, options.timeoutMs ?? 60_000, options.signal);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.stop();
		failAll(this.state, new Error("MCP connection closed"));
		await this.transport.close();
	}
}

function deliver(state: RpcState, message: JsonRpcMessage): void {
	if (!isJsonRpcResponse(message)) return;
	const entry = state.pending.get(message.id);
	if (!entry) return;
	state.pending.delete(message.id);
	clearTimeout(entry.timer);
	entry.signal?.removeEventListener("abort", entry.onAbort);
	if ("error" in message) entry.reject(new McpError(message.error.code, message.error.message, message.error.data));
	else entry.resolve(message.result);
}

function failAll(state: RpcState, error: Error): void {
	for (const entry of state.pending.values()) {
		clearTimeout(entry.timer);
		entry.reject(error);
	}
	state.pending.clear();
}

function send(
	transport: McpTransport,
	state: RpcState,
	method: string,
	params: Record<string, unknown> | undefined,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<unknown> {
	if (signal?.aborted) return Promise.reject(new Error("aborted"));
	const id = state.nextId++;
	const body: JsonRpcRequest = {
		jsonrpc: "2.0",
		id,
		method,
		params: { ...params, _meta: { ...(isRecord(params?._meta) ? params._meta : {}), ...protocolMeta() } },
	};
	return new Promise((resolve, reject) => {
		const entry: Pending = {
			resolve,
			reject,
			signal,
			timer: setTimeout(() => {
				state.pending.delete(id);
				signal?.removeEventListener("abort", entry.onAbort);
				reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs),
			onAbort: () => {
				clearTimeout(entry.timer);
				state.pending.delete(id);
				reject(new Error("aborted"));
				const cancel: JsonRpcMessage = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } };
				void transport.send(cancel).catch(() => undefined);
			},
		};
		state.pending.set(id, entry);
		signal?.addEventListener("abort", entry.onAbort, { once: true });
		transport.send(body).catch((error: unknown) => {
			clearTimeout(entry.timer);
			state.pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

/** `whsec_` plus base64 that decodes to 24–64 bytes, as the events draft and ChatGPT require. */
export function isWebhookSecret(secret: string): boolean {
	if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false;
	const raw = secret.slice("whsec_".length);
	const decoded = Buffer.from(raw, "base64");
	if (decoded.length < 24 || decoded.length > 64) return false;
	return decoded.toString("base64").replace(/=+$/, "") === raw.replace(/=+$/, "");
}

export function signWebhook(secret: string, id: string, timestamp: string, body: string): string {
	const key = Buffer.from(secret.slice("whsec_".length), "base64");
	const mac = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
	return `v1,${mac}`;
}

export function verifyWebhook(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: string, nowMs = Date.now()): boolean {
	const { id, timestamp, signature } = headers;
	if (!id || !timestamp || !signature || !isWebhookSecret(secret)) return false;
	const seconds = Number(timestamp);
	if (!Number.isFinite(seconds) || Math.abs(nowMs / 1000 - seconds) > 5 * 60) return false;
	const expected = signWebhook(secret, id, timestamp, body);
	return signature.split(" ").some((part) => part.length === expected.length && timingSafeEqual(Buffer.from(part), Buffer.from(expected)));
}

/** Response to one callback POST. Verification echoes the challenge. Other signed bodies are accepted. */
export function callbackResponse(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: string, nowMs = Date.now()): { status: number; body: string } {
	if (!verifyWebhook(secret, headers, body, nowMs)) return { status: 401, body: "" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { status: 400, body: "" };
	}
	if (isRecord(parsed) && parsed.type === "verification" && typeof parsed.challenge === "string") {
		return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
	}
	return { status: 200, body: "" };
}


