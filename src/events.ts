import { JSON_RPC_ERROR_CODES, McpError } from "@earendil-works/pi-mcp";
import type { EventSession } from "./wire.ts";

export interface EventTypeInfo {
	name: string;
	description?: string;
	delivery: string[];
	inputSchema?: Record<string, unknown>;
	payloadSchema?: Record<string, unknown>;
}

const DELIVERY = new Set(["webhook"]);

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

/** Follow `events/list` pages. Method-not-found means the server has no events. */
export async function listEventTypes(session: EventSession, signal?: AbortSignal): Promise<EventTypeInfo[]> {
	if (!("events" in session.discover.capabilities)) return [];
	const types: EventTypeInfo[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < 1000; page++) {
		let result: unknown;
		try {
			result = await session.request("events/list", cursor === undefined ? {} : { cursor }, { signal });
		} catch (error) {
			if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return [];
			throw error;
		}
		if (!isRecord(result) || !Array.isArray(result.events)) throw new Error("Invalid events/list result");
		for (const entry of result.events) {
			const parsed = parseEventType(entry);
			if (!parsed || !parsed.delivery.includes("webhook")) continue;
			types.push(parsed);
		}
		const next = result.nextCursor;
		if (typeof next !== "string" || next === "" || seen.has(next)) return types;
		seen.add(next);
		cursor = next;
	}
	throw new Error("events/list exceeded 1000 pages");
}


