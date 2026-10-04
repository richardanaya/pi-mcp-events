# pi-mcp-events

A pi extension that manages MCP events on the servers `/mcp` already knows.

Events are not part of the MCP specification. The written text is the [draft design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md). ChatGPT implements the webhook slice of that draft on protocol `2026-07-28`. This extension speaks that protocol and that slice, and it also calls poll and push when a server advertises them.

Pi's own MCP client does not implement events. It still uses the `2025-11-25` `initialize` handshake. This package opens its own connection: `server/discover` first, then every request carries `io.modelcontextprotocol/protocolVersion: "2026-07-28"` in `_meta`. A server that only speaks `2025-11-25` fails discovery and is reported as an error.

## What is supported

`events/list` returns each event type with a `delivery` array. A tool runs only when that array includes the mode. If you have not scanned yet, the tool does not know the list and lets the server accept or reject the call.

| Tool | Method | When |
| --- | --- | --- |
| `mcp_events_status` | none | Shows configured servers, how each one authenticates, and the last scan. Does not connect. |
| `mcp_events_scan` | `server/discover`, then `events/list` | Connects when called. Keeps types whose delivery includes `poll`, `push`, or `webhook`. |
| `mcp_events_subscribe` | `events/subscribe` | `delivery` includes `webhook`. |
| `mcp_events_unsubscribe` | `events/unsubscribe` | Same server, event name, arguments, and callback URL as subscribe. |
| `mcp_events_poll` | `events/poll` | `delivery` includes `poll`. One request. Call again immediately when `hasMore` is true, otherwise after `nextPollMs`. |
| `mcp_events_stream` | `events/stream` | `delivery` includes `push`. Reads until `waitMs` (default 15s) or `maxEvents` (default 20), then closes the stream. Heartbeats advance the cursor. |

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

Add the package path to pi's `extensions` setting, or install `pi-mcp-events` from npm. The published package is the TypeScript sources pi loads. Version 0.1.0.

`npm publish` runs the tests through `prepublishOnly`.
