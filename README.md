# pi-mcp-events

A pi extension that finds the MCP servers `/mcp` already knows and manages [MCP Events](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md) on them.

Pi's own MCP client speaks the `2025-11-25` handshake and does not implement events. This extension opens MCP `2026-07-28`: `server/discover` first, then each request carries `io.modelcontextprotocol/protocolVersion` in `_meta`. There is no `initialize`.

`events/list` keeps each event type's `delivery` array (`poll`, `push`, `webhook`). Use only a mode that type advertises. Webhook subscribe and unsubscribe send `delivery.mode: "webhook"`. The secret is `whsec_` plus base64 of 24–64 bytes, and the callback must be `https`. Subscriptions are stored in `<getAgentDir()>/mcp-events.json`. While pi is open, a webhook subscription is refreshed one minute before `refreshBefore`, sending the last cursor. This process does not receive the webhook. The callback URL you pass does. Poll is one `events/poll` per call. Push reads `events/stream` until `waitMs` or `maxEvents`, and heartbeats update the cursor.

## Servers and auth

It reads the same places `/mcp` does:

- `<getAgentDir()>/mcp.json`. That is `$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. The directory name comes from `CONFIG_DIR_NAME` in the coding-agent package (`piConfig.configDir`, default `.pi`), and the env var name is `${APP_NAME}_CODING_AGENT_DIR`.
- `<cwd>/<CONFIG_DIR_NAME>/mcp.json` when the project is trusted
- servers registered with `pi.registerMcpServer()`, unless a file already defines that name

HTTP auth matches pi:

- an `Authorization` header, with `${VAR}` expanded from the environment
- `auth.provider`, using the token from `/login` for that provider
- otherwise the OAuth access token `/mcp` saved in `mcp-auth.json` under `mcp__<name>|<url>`

It does not open a browser. A server with no stored token is reported as needing `/mcp` sign-in.

## Tools

Event types are not registered one-by-one. The same tools manage every server:

| Tool | Protocol |
| --- | --- |
| `mcp_events_status` | none (config and last scan) |
| `mcp_events_scan` | `server/discover`, then `events/list` |
| `mcp_events_poll` | `events/poll`, when delivery includes `poll` |
| `mcp_events_stream` | `events/stream`, when delivery includes `push` |
| `mcp_events_subscribe` | `events/subscribe`, when delivery includes `webhook` |
| `mcp_events_unsubscribe` | `events/unsubscribe` |

`mcp_events_scan` connects only when called, so it does not start a second copy of each stdio server at session startup.

## Install

```bash
cd ~/repos/pi-mcp-events
npm install --ignore-scripts
```

Add the package path to pi's `extensions` setting, or install it from npm as `pi-mcp-events`. The package publishes the TypeScript sources pi loads. Version 0.1.0.

Publish with `npm publish` from a clean tree after `npm test`. `prepublishOnly` runs the tests.
