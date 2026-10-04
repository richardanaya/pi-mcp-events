import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mcpAuthKey } from "../src/auth.ts";
import { parseEventOccurrence, parseEventType } from "../src/events.ts";
import { expandEnv, loadServers } from "../src/servers.ts";

describe("loadServers", () => {
	it("lets a project file replace a global server and keeps extension servers that do not clash", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-events-"));
		const agent = join(dir, "agent");
		const cwd = join(dir, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agent, { recursive: true });
		writeFileSync(
			join(agent, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					docs: { url: "https://global.example/mcp" },
					files: { command: "files-mcp", enabled: false },
				},
			}),
		);
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://project.example/mcp" }, files: { enabled: true } } }));
		const loaded = loadServers({
			cwd,
			projectTrusted: true,
			agentDirectory: agent,
			configDirName: ".pi",
			registered: [{ name: "docs", config: { url: "https://extension.example/mcp" } }, { name: "extra", config: { command: "extra-mcp" } }],
		});
		assert.equal(loaded.errors.length, 0);
		assert.equal(loaded.servers.get("docs")?.source, "project");
		assert.equal(loaded.servers.get("docs")?.config && "url" in loaded.servers.get("docs")!.config && loaded.servers.get("docs")!.config.url, "https://project.example/mcp");
		assert.equal(loaded.servers.get("files")?.enabled, true);
		assert.equal(loaded.servers.get("extra")?.source, "extension");
	});

	it("ignores project mcp.json when the project is not trusted", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-events-"));
		const cwd = join(dir, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { local: { command: "local" } } }));
		const loaded = loadServers({ cwd, projectTrusted: false, agentDirectory: join(dir, "missing"), configDirName: ".pi", registered: [] });
		assert.equal(loaded.servers.size, 0);
	});
});

describe("auth key", () => {
	it("matches pi's mcp-auth.json key", () => {
		assert.equal(mcpAuthKey("my-server", "https://example.com/mcp"), "mcp__my_server|https://example.com/mcp");
	});
});

describe("env", () => {
	it("expands ${NAME} and fails when it is missing", () => {
		assert.equal(expandEnv("Bearer ${TOKEN}", { TOKEN: "abc" }), "Bearer abc");
		assert.throws(() => expandEnv("${MISSING}", {}), /MISSING/);
	});
});

describe("event parsing", () => {
	it("keeps known delivery modes and occurrence fields", () => {
		const type = parseEventType({
			name: "email.received",
			description: "inbox",
			delivery: ["poll", "carrier-pigeon"],
			inputSchema: { type: "object" },
		});
		assert.deepEqual(type, {
			name: "email.received",
			description: "inbox",
			delivery: ["poll"],
			inputSchema: { type: "object" },
		});
		assert.equal(parseEventType({ name: "" }), undefined);
		const event = parseEventOccurrence({
			eventId: "evt_1",
			name: "email.received",
			timestamp: "2026-02-19T15:30:00Z",
			data: { subject: "hi" },
			cursor: null,
		});
		assert.equal(event?.cursor, null);
		assert.equal(event?.data.subject, "hi");
	});
});
