# pi-mcp-events

A pi extension that manages MCP events on the servers `/mcp` already knows.

Events are not part of the MCP specification. The written text is the [draft design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md). ChatGPT implements the webhook slice of that draft on protocol `2026-07-28`. This extension speaks that protocol and that slice, and it also calls poll and push when a server advertises them.

Pi's own MCP client does not implement events. It still uses the `2025-11-25` `initialize` handshake. This package opens its own connection: `server/discover` first, then every request carries `io.modelcontextprotocol/protocolVersion: "2026-07-28"` in `_meta`. A server that only speaks `2025-11-25` fails discovery and is reported as an error.

## What is supported

`events/list` returns each event type with a `delivery` array. A tool runs only when that array includes the mode. If you have not scanned yet, the tool does not know the list and lets the server accept or reject the call.

Names follow pi's MCP tools: `mcp__<server>__<tool>`, sanitized to `[A-Za-z0-9_]` and hashed down to 64 characters when needed. The tool segment starts with `events`. Dots in an event name become underscores, so `demo.tick` on server `sprite` is `mcp__sprite__events__demo_tick__poll`.

Session start registers scan and status for each enabled server. Scan registers one tool per advertised delivery mode. The server and event are not arguments.

| Tool | Method |
| --- | --- |
| `mcp__<server>__events__status` | none. Auth and the last scan. |
| `mcp__<server>__events__scan` | `server/discover`, then `events/list`. |
| `mcp__<server>__events__<event>__subscribe` | `events/subscribe`, when delivery includes `webhook`. |
| `mcp__<server>__events__<event>__unsubscribe` | `events/unsubscribe`. |
| `mcp__<server>__events__<event>__poll` | `events/poll`, when delivery includes `poll`. One request. Call again immediately when `hasMore` is true, otherwise after `nextPollMs`. |
| `mcp__<server>__events__<event>__stream` | `events/stream`, when delivery includes `push`. Waits for `maxEvents` events (default 1) with no time limit. `waitMs` is only for when the user asked for a time limit. Heartbeats advance the cursor. |

Webhook requests match the ChatGPT slice:

- `delivery.mode` is `"webhook"`.
- The callback URL is `https`.
- The secret is `whsec_` plus base64 of 24–64 bytes. The caller supplies it. The extension does not generate it.
- `cursor: null` starts from now. A later subscribe sends the cursor from the previous subscribe response.
- The same server, event name, arguments, and URL refresh the subscription. The result is stored in `<getAgentDir()>/mcp-events.json`. While pi is open, refresh runs one minute before `refreshBefore`. If pi was closed past that time, the next session start sends the refresh.

## What is not supported

- This process does not receive webhooks. It does not answer a `verification` challenge or check a delivery signature on a listening port. The callback URL you pass has to do that. A helper that checks a signature exists in the package and is not wired to a server.
- The stored cursor does not move when events are delivered. It moves on subscribe, refresh, poll, and stream.
- Push is a bounded read, not a standing subscription. There is no reconnect, and `notifications/events/error` and `notifications/events/terminated` are not handled.
- Poll is not a background loop. The model calls the tool again.
- `notifications/events/list_changed` is not watched. The connection closes when the tool finishes.
- `gap` and `terminated` webhook control messages are not handled. ChatGPT does not support them either.
- No browser sign-in. HTTP auth is an `Authorization` header, a `/login` provider token, or the OAuth access token `/mcp` already saved in `mcp-auth.json`.

## Servers

Same places as `/mcp`:

- `<getAgentDir()>/mcp.json`. `$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. The directory name is `CONFIG_DIR_NAME` from the coding-agent package (`piConfig.configDir`, default `.pi`). The env var is `${APP_NAME}_CODING_AGENT_DIR`.
- `<cwd>/<CONFIG_DIR_NAME>/mcp.json` when the project is trusted.
- `pi.registerMcpServer()`, unless a file already defines that name.

A scan does not run at session startup, so it does not start a second copy of each stdio server.

## Install

```bash
cd ~/repos/pi-mcp-events
npm install --ignore-scripts
```

Add the package path to pi's `extensions` setting, or install `pi-mcp-events` from npm. The published package is the TypeScript sources pi loads. Version 0.1.1.

`npm publish` runs the tests through `prepublishOnly`.
