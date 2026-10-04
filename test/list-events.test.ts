import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type JsonRpcMessage, type JsonRpcRequest } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { connectClient, listEventTypes } from "../src/events.ts";

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
	return "id" in message && "method" in message;
}

describe("listEventTypes", () => {
	it("reads events/list when the server advertises the capability", async () => {
		const { client: clientTransport, server } = createInMemoryTransportPair();
		await server.start();
		server.onMessage((message) => {
			if (!isRequest(message)) return;
			if (message.method === "initialize") {
				void server.send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: "2025-11-25",
						capabilities: { events: { listChanged: true } },
						serverInfo: { name: "fixture", version: "0" },
					},
				});
				return;
			}
			if (message.method === "notifications/initialized") return;
			if (message.method === "events/list") {
				void server.send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						events: [{ name: "incident.created", description: "page", delivery: ["webhook", "poll"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } }],
					},
				});
			}
		});
		const client = await connectClient(clientTransport);
		const types = await listEventTypes(client);
		assert.equal(types.length, 1);
		assert.equal(types[0]?.name, "incident.created");
		assert.deepEqual(types[0]?.delivery, ["webhook", "poll"]);
		await client.close();
	});

	it("returns no events when the server does not advertise the capability", async () => {
		const { client: clientTransport, server } = createInMemoryTransportPair();
		await server.start();
		server.onMessage((message) => {
			if (!isRequest(message) || message.method !== "initialize") return;
			void server.send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "fixture", version: "0" },
				},
			});
		});
		const client = await connectClient(clientTransport);
		assert.deepEqual(await listEventTypes(client), []);
		await client.close();
	});
});
