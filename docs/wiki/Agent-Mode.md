# Agent Mode

When you click **Ask**, Astra Dock runs a bounded tool-call loop against your chosen provider. The loop ends when the model returns plain text, the iteration cap (8) trips, the wall-clock budget (90 s) expires, or you cancel with `⌘⎋`.

## Loop sketch

```
Ask
 │
 ▼
runAgent({ prompt, providerId, model, includeScreen })
 │
 ▼  for each model turn:
   provider.chat({ messages, tools: registry.toXToolSpecs() })
   │
   ├──  no tool_calls   →  emit 'final' → reply panel
   │
   └──  tool_calls      →  for each:
                            permissions.evaluate → 'auto' | 'prompt'
                            if 'prompt': renderer shows approval card; loop pauses
                            on approve: handler runs with AbortSignal
                            tool result wrapped <tool_output server="…" untrusted>…</tool_output>
                            audit log records every outcome
                          loop continues
```

Cancellation: `⌘⎋` (Panic) clears the session image buffer AND aborts the in-flight agent run (rejects pending approvals, signals tool handlers).

## Effect × policy

Every tool declares an intrinsic **effect**:

| Effect | Meaning | Default policy |
|---|---|---|
| `read` | Inspect, list, capture | `auto` |
| `write` | Mutate state somewhere | `prompt` |
| `exec` | Run a command, eval, SQL | `always-prompt` |

You override per tool, per server, or globally in **⚙ → Agent · Tools & Permissions**:

| Policy | Behavior |
|---|---|
| `auto` | No approval, just run |
| `prompt` | Approval card every call |
| `always-prompt` | Approval card every call, can't be bypassed by session grants |

`always-prompt` wins over everything. Tip: keep `exec` tools at `always-prompt`.

## Approval card

The card lives inside the pill shell. Its border is risk-colored: amber for `write`, red for `exec`, indigo for `read`. It shows:

- The tool id (and server id for MCP tools)
- A short preview from `tool.renderPreview(args)`
- A collapsible JSON view of the full args
- Three buttons: **Approve** (Cmd+Y) · **Approve server (15m)** · **Deny** (Cmd+N)

"Approve server (15 min)" is an in-memory grant — it doesn't survive a restart. It also never auto-runs `exec` tools, even if the policy says `auto`.

## Cross-server escalation

If a `write` or `exec` tool fires within 2 turns of a *different* MCP server's tool result, the call is force-prompted regardless of policy. This mitigates prompt-injection attacks where one tool's output coaxes another to do something destructive. The system prompt also instructs the model to treat all `<tool_output untrusted>` content as data, not instructions.

## Audit log

Every tool call lands in `~/Library/Application Support/astra-dock/audit.log` (JSONL, rotated at 10 MB → `audit.log.1`). Each entry:

```json
{
  "ts": "2026-05-15T17:42:00.123Z",
  "id": "mcp.github.list_pull_requests",
  "source": "mcp",
  "serverId": "github",
  "args_hash": "<sha256 hex>",
  "approver": "user",
  "result_bytes": 2143,
  "duration_ms": 612,
  "status": "ok"
}
```

By default the args themselves are NOT persisted (hash only). Flip `redactionMode: 'redact'` in code to keep redacted args for debugging. Sensitive field names (`api_key`, `password`, `authToken`, etc.) are always replaced with `[REDACTED]`.

View the tail in **⚙ → Agent · Tools & Permissions → Recent activity**.

## Bounds you can tune

In `agents/router.js`'s `createRouter`:

- `maxIterations` (default 8)
- `wallClockMs` (default 90_000)
- External `AbortSignal` via `opts.signal`
- `permissions.crossServerWindow` (default 2 turns)

These aren't exposed in the UI yet. PR-D or later may surface them.
