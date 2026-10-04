import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mcpAuthKey } from "../src/auth.ts";
import { parseEventType } from "../src/events.ts";
import { createEventToolName, eventToolSegment } from "../src/names.ts";
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

describe("tool names", () => {
	it("uses pi's mcp__server__tool form", () => {
		assert.equal(createEventToolName("sprite", eventToolSegment("poll", "demo.tick")), "mcp__sprite__events__demo_tick__poll");
		assert.equal(createEventToolName("my-server", eventToolSegment("scan")), "mcp__my_server__events__scan");
		const long = createEventToolName("s".repeat(40), eventToolSegment("subscribe", "e".repeat(40)));
		assert.equal(long.length, 64);
	});
});

describe("event parsing", () => {
	it("keeps poll, push, and webhook", () => {
		const type = parseEventType({
			name: "email.received",
			description: "inbox",
			delivery: ["poll", "push", "webhook", "carrier-pigeon"],
			inputSchema: { type: "object" },
		});
		assert.deepEqual(type?.delivery, ["poll", "push", "webhook"]);
		assert.equal(parseEventType({ name: "" }), undefined);
		assert.deepEqual(parseEventType({ name: "email.received", delivery: ["poll"] })?.delivery, ["poll"]);
	});
});
