import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type JsonRpcMessage, type JsonRpcRequest } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { listEventTypes } from "../src/events.ts";
import { callbackResponse, isWebhookSecret, PROTOCOL_VERSION, signWebhook } from "../src/wire.ts";
import { EventSession } from "../src/wire.ts";

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
	return "id" in message && "method" in message;
}

const SECRET = `whsec_${Buffer.from("0123456789abcdef01234567").toString("base64")}`;

describe("listEventTypes", () => {
	it("discovers MCP 2026-07-28 and reads events/list", async () => {
		const { client: clientTransport, server } = createInMemoryTransportPair();
		await server.start();
		server.onMessage((message) => {
			if (!isRequest(message)) return;
			const meta = (message.params as { _meta?: Record<string, string> } | undefined)?._meta;
			assert.equal(meta?.["io.modelcontextprotocol/protocolVersion"], PROTOCOL_VERSION);
			if (message.method === "server/discover") {
				void server.send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						resultType: "complete",
						supportedVersions: [PROTOCOL_VERSION],
						capabilities: { tools: {}, events: {} },
						serverInfo: { name: "fixture", version: "0" },
					},
				});
				return;
			}
			if (message.method === "events/list") {
				void server.send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						events: [{ name: "comment.created", description: "review", delivery: ["webhook"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } }],
					},
				});
			}
		});
		const session = await EventSession.open(clientTransport);
		const types = await listEventTypes(session);
		assert.equal(types[0]?.name, "comment.created");
		assert.deepEqual(types[0]?.delivery, ["webhook"]);
		await session.close();
	});
});

describe("webhook callback", () => {
	it("accepts a 24-byte whsec secret and echoes a signed verification challenge", () => {
		assert.equal(isWebhookSecret(SECRET), true);
		assert.equal(isWebhookSecret("whsec_YQ=="), false);
		const body = JSON.stringify({ type: "verification", challenge: "once" });
		const timestamp = "1739980800";
		const signature = signWebhook(SECRET, "msg_verification_1", timestamp, body);
		const ok = callbackResponse(SECRET, { id: "msg_verification_1", timestamp, signature }, body, 1739980800 * 1000);
		assert.equal(ok.status, 200);
		assert.deepEqual(JSON.parse(ok.body), { challenge: "once" });
		const bad = callbackResponse(SECRET, { id: "msg_verification_1", timestamp, signature: "v1,nope" }, body, 1739980800 * 1000);
		assert.equal(bad.status, 401);
	});
});
