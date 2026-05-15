# MCP Servers

Astra Dock acts as an MCP **client** today (PR-B + PR-C). PR-D adds the inverse: Astra as an MCP **server** that Claude Code / Codex / Cursor can call into.

Two flows live in **⚙ → MCP Servers**:

## ＋ Connect to a remote MCP server (URL + auth) *(primary)*

For hosted MCPs — GitHub's MCP, Notion, internal company APIs, Sentry, etc.

| Field | What to put |
|---|---|
| **id** | A short label (e.g. `github`). Lowercase + alphanumeric. |
| **URL** | The MCP endpoint, e.g. `https://api.githubcopilot.com/mcp/`. Must be `http://` or `https://`. |
| **Bearer token** | Your PAT / API key / OAuth token. **Stored encrypted at rest** via macOS `safeStorage`. |
| **Additional headers** | Optional extra headers, one per line in `HEADER: value` format. `Authorization` is reserved — set it via Bearer token. |

After save, click **Connect**. The discovered tool list appears. Click **＋ Register all** to add every tool to the agent's registry (each gets a heuristically inferred `effect` and policy `default`, which means `prompt` for writes and `auto` for reads).

The bearer token is never sent back to the renderer — the card shows `🔒 Authorization: Bearer •••••` once it's set. Click **edit** to rotate.

### HTTPS warning

If the URL is plaintext `http://`, the card surfaces a warning. Don't ship tokens over plaintext. Localhost (`http://127.0.0.1`) is the only sane exception.

## ＋ Add local MCP server (stdio — advanced)

For MCPs you spawn locally — Claude Code (`claude mcp serve`), the filesystem MCP, sqlite, etc.

| Field | What to put |
|---|---|
| **id** | Short label. |
| **command** | Absolute path is strongly recommended — see [FAQ → PATH](FAQ) for why. e.g. `/opt/homebrew/bin/npx`. |
| **args** | One per line. |
| **env** | Optional KEY=value lines layered onto the inherited login-shell env. |

Example: the official filesystem MCP scoped to a project:

```
id:       filesystem
command:  /opt/homebrew/bin/npx
args:     -y
          @modelcontextprotocol/server-filesystem
          /Users/you/projects/myrepo
```

Connect → the card lists the tools (`read_file`, `write_file`, `list_directory`, etc.). Each tool's schema is linted: a `path` field gets a medium-severity warning chip; `command`-like fields get high-severity. Effect is inferred from the verb (`read_*` → read, `write_*` → write, etc.).

## Schema linter

For each discovered tool, **schemaLinter** flags:

| Kind | When | Severity |
|---|---|---|
| `sensitive-field` | Field name looks like a credential (`api_key`, `password`, `token`, …) | high |
| `path-field` | String field named like a path (`path`, `file`, `directory`, …) | medium |
| `exec-field` | Field name suggests execution (`command`, `sql`, `shell`, …) | high |
| `open-schema` | Top-level `additionalProperties` permissive | low |

These are *advisory*. They appear as colored chips on the tool row so you can decide whether to register and at what policy.

## Tool registration

Connecting a server **does not** make its tools callable by the agent. You register what you want:

- **＋ Register all (N)** on the server card — bulk register all discovered tools.
- **Add to registry** on a single row — pick one.
- **Unregister** — remove from the registry (without disconnecting the server).

Once registered, a tool appears as `mcp.<serverId>.<toolName>` in **Agent · Tools & Permissions** with a policy dropdown. The agent calls it via the proxy handler in `mcpClient.js`, which forwards through `client.callTool({ name, arguments })` with an `AbortSignal`.

A warning banner appears at the top of MCP Servers when at least one server is connected with zero tools registered — that's the most common "why isn't the agent using my MCP?" gotcha.

## Disconnect / Remove

- **Disconnect** closes the transport and **unregisters** all of that server's tools from the registry. The config remains saved.
- **Remove** disconnects, unregisters, and deletes the config.

## Persistence

Server configs live in `prefs.json` (in `app.getPath('userData')`). The plaintext bearer token is **never written** — only `bearerToken_enc` (safeStorage-encrypted) is. On restart, configs are hydrated back into memory, but **nothing auto-connects** — you opt in each time.

## What's recommended today

A short list (PR-E will expand this with full snippets):

- **GitHub's official MCP** — `https://api.githubcopilot.com/mcp/` + a PAT
- **Filesystem (local)** — `npx -y @modelcontextprotocol/server-filesystem <project root>`
- **SQLite (local)** — `npx -y @modelcontextprotocol/server-sqlite <db path>`
- **Claude Code (local)** — `claude mcp serve` (use the absolute `claude` path)

Each of these matches our security defaults; tools you don't recognize should stay at `prompt` policy until you trust the call.
