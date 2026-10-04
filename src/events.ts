import { JSON_RPC_ERROR_CODES, McpClient, McpError, type McpTransport } from "@earendil-works/pi-mcp";

export interface EventTypeInfo {
	name: string;
	description?: string;
	delivery: string[];
	inputSchema?: Record<string, unknown>;
	payloadSchema?: Record<string, unknown>;
}

export interface EventOccurrence {
	eventId: string;
	name: string;
	timestamp: string;
	data: Record<string, unknown>;
	cursor?: string | null;
}

const DELIVERY = new Set(["poll", "push", "webhook"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEventType(value: unknown): EventTypeInfo | undefined {
	if (!isRecord(value) || typeof value.name !== "string" || !value.name) return undefined;
	const delivery = Array.isArray(value.delivery) ? value.delivery.filter((mode): mode is string => typeof mode === "string" && DELIVERY.has(mode)) : [];
	return {
		name: value.name,
		...(typeof value.description === "string" ? { description: value.description } : {}),
		delivery,
		...(isRecord(value.inputSchema) ? { inputSchema: value.inputSchema } : {}),
		...(isRecord(value.payloadSchema) ? { payloadSchema: value.payloadSchema } : {}),
	};
}

export function parseEventOccurrence(value: unknown): EventOccurrence | undefined {
	if (!isRecord(value) || typeof value.eventId !== "string" || typeof value.name !== "string" || typeof value.timestamp !== "string" || !isRecord(value.data)) {
		return undefined;
	}
	const cursor = value.cursor;
	return {
		eventId: value.eventId,
		name: value.name,
		timestamp: value.timestamp,
		data: value.data,
		...(cursor === undefined ? {} : { cursor: cursor === null || typeof cursor === "string" ? cursor : undefined }),
	};
}

/** Follow `events/list` pages. Method-not-found means the server has no events. */
export async function listEventTypes(client: McpClient, signal?: AbortSignal): Promise<EventTypeInfo[]> {
	const caps = client.serverCapabilities as Record<string, unknown> | undefined;
	if (!caps || !("events" in caps)) return [];
	const types: EventTypeInfo[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < 1000; page++) {
		let result: unknown;
		try {
			result = await client.request("events/list", cursor === undefined ? {} : { cursor }, { signal });
		} catch (error) {
			if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return [];
			throw error;
		}
		if (!isRecord(result) || !Array.isArray(result.events)) throw new Error("Invalid events/list result");
		for (const entry of result.events) {
			const parsed = parseEventType(entry);
			if (!parsed) throw new Error("Invalid event type in events/list");
			types.push(parsed);
		}
		const next = result.nextCursor;
		if (typeof next !== "string" || next === "" || seen.has(next)) return types;
		seen.add(next);
		cursor = next;
	}
	throw new Error("events/list exceeded 1000 pages");
}

export async function connectClient(transport: McpTransport): Promise<McpClient> {
	const client = new McpClient({ name: "pi-mcp-events", version: "0.1.0" });
	await client.connect(transport);
	return client;
}
