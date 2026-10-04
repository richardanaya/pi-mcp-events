import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SavedSubscription {
	server: string;
	name: string;
	arguments: Record<string, unknown>;
	url: string;
	secret: string;
	cursor: string | null;
	id?: string;
	refreshBefore: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function subscriptionKey(sub: Pick<SavedSubscription, "server" | "name" | "arguments" | "url">): string {
	return JSON.stringify([sub.server, sub.name, canonical(sub.arguments), sub.url]);
}

export function loadSubscriptions(path: string): SavedSubscription[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isSubscription);
	} catch {
		return [];
	}
}

function isSubscription(value: unknown): value is SavedSubscription {
	if (!isRecord(value)) return false;
	return typeof value.server === "string" && typeof value.name === "string" && isRecord(value.arguments) && typeof value.url === "string" && typeof value.secret === "string" && (value.cursor === null || typeof value.cursor === "string") && (value.refreshBefore === null || typeof value.refreshBefore === "string");
}

export function saveSubscriptions(path: string, subscriptions: readonly SavedSubscription[]): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(subscriptions, null, 2)}\n`, { mode: 0o600 });
}

export function upsertSubscription(path: string, subscription: SavedSubscription): void {
	const all = loadSubscriptions(path);
	const key = subscriptionKey(subscription);
	const next = all.filter((entry) => subscriptionKey(entry) !== key);
	next.push(subscription);
	saveSubscriptions(path, next);
}

export function removeSubscription(path: string, subscription: Pick<SavedSubscription, "server" | "name" | "arguments" | "url">): void {
	const key = subscriptionKey(subscription);
	saveSubscriptions(path, loadSubscriptions(path).filter((entry) => subscriptionKey(entry) !== key));
}

export function parseSubscribeResult(value: unknown): { id?: string; refreshBefore: string | null; cursor: string | null; truncated: boolean } {
	if (!isRecord(value)) throw new Error("Invalid events/subscribe result");
	const refreshBefore = value.refreshBefore === null || value.refreshBefore === undefined ? null : value.refreshBefore;
	const cursor = value.cursor === null || value.cursor === undefined ? null : value.cursor;
	if (refreshBefore !== null && typeof refreshBefore !== "string") throw new Error("Invalid events/subscribe refreshBefore");
	if (cursor !== null && typeof cursor !== "string") throw new Error("Invalid events/subscribe cursor");
	return {
		...(typeof value.id === "string" ? { id: value.id } : {}),
		refreshBefore,
		cursor,
		truncated: value.truncated === true,
	};
}
