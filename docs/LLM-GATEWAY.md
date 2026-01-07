# LLM Gateway (Anthropax: Anthropic main + MiniMax subagents)

CC-MIRROR can run Claude Code on Anthropic OAuth/subscription for normal requests while routing **subagent** calls to MiniMax via a localhost HTTP gateway.

This document defines the exact wire contract supported by the gateway.

## Routing Contract

### Routing signal

Routing is determined **only** for `POST /v1/messages` by the `model` prefix:

- `minimax:<model>` → route to MiniMax (model prefix is stripped before forwarding)
- anything else → route to Anthropic

### How Claude Code reaches the gateway

cc-mirror supports two integration modes:

1) **`fetch-hook`** (default for `anthropic-router`)
   - Claude Code continues to talk to `https://api.anthropic.com` (OAuth/subscription works)
   - A small preload hook redirects only `POST /v1/messages` calls whose JSON `model` starts with `minimax:` to the localhost gateway

2) **`base-url`** (legacy)
   - Claude Code is pointed at the gateway by setting `ANTHROPIC_BASE_URL` to the localhost gateway
   - This is simpler, but **Anthropic OAuth does not work** when `ANTHROPIC_BASE_URL` is not `api.anthropic.com`

### Path-prefix security

Claude Code is pointed at the gateway using a per-launch random path prefix:

- Gateway base URL: `http://127.0.0.1:<port>/<randomPrefix>`
- The gateway serves **only** under `/<randomPrefix>/...`
- `/<randomPrefix>/healthz` returns `200 OK`

## Upstreams

- Anthropic: `https://api.anthropic.com`
- MiniMax: `https://api.minimax.io/anthropic`

## Auth & Header Policy

### Default passthrough (safety baseline)

For any request **except** `POST /v1/messages`, the gateway forwards to Anthropic unchanged (method/path/query/body) and preserves upstream status/headers/body.

### `POST /v1/messages` forwarding rules

Forwarded to **all** upstreams:

- `content-type`, `accept`, `user-agent`, `anthropic-version`
- Optional: `x-request-id`

Forwarded to **Anthropic only**:

- incoming `authorization` and/or `x-api-key`
- incoming `anthropic-beta` (unchanged)

For **MiniMax**:

- drop incoming `authorization`, `x-api-key`, and `anthropic-beta`
- inject `authorization: Bearer <MINIMAX_API_KEY>`

## Streaming (SSE)

If the request JSON includes `stream: true`:

- the gateway still parses the initial JSON request (to route it)
- the streamed response is proxied byte-for-byte (no SSE parsing or rechunking)
- upstream `content-type: text/event-stream` and status codes are preserved

## Capability-Based Fallbacks (force Anthropic)

Before routing to MiniMax, the gateway scans the JSON and forces routing to Anthropic if any of these are true:

1) Any content block of type `"image"` or `"document"` anywhere in the request
2) Any unknown content block type not in: `text`, `tool_use`, `tool_result`, `image`, `document`
3) Any key named `file_id` anywhere in the JSON
4) MiniMax temperature validity: if `temperature` exists and is `<= 0` or `> 1`

When falling back from a `minimax:` model, the gateway rewrites `model` to an Anthropic fallback model so the request can succeed.

## Settings Schema

Router variants separate env passed to Claude Code from env used only by the gateway:

`config/settings.json`

- `env`: exported into the Claude Code process environment
- `proxyEnv`: read by the gateway only (never exported to Claude Code)
  - `MINIMAX_API_KEY` is stored here
