import { createHash } from "node:crypto";

/** Same limit and hash pi uses for `mcp__<server>__<tool>`. */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * `mcp__<server>__events__...`, sanitized like pi's MCP tools. Characters outside `[A-Za-z0-9_]`
 * become `_`. A name longer than 64 characters, or one that collides after sanitizing, keeps a
 * short hash of the original server and tool segments.
 */
export function createEventToolName(server: string, tool: string, isTaken: (name: string) => boolean = () => false): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/** Tool segment after `mcp__<server>__`. Scan and status have no event name. */
export function eventToolSegment(action: "scan" | "status" | "poll" | "stream" | "subscribe" | "unsubscribe", eventName?: string): string {
	return eventName === undefined ? `events__${action}` : `events__${eventName}__${action}`;
}
