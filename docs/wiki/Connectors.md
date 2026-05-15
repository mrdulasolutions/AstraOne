# Connectors

Astra Dock connects to existing MCP servers — most things you'd want as a "connector" (Gmail, GitHub, Calendar, Slack, etc.) already have official or community MCP implementations. Drop their config into Astra and the agent can use them.

> All paths below assume Apple Silicon (`/opt/homebrew/bin/...`). On Intel Macs use `/usr/local/bin/...`. Other shells / package managers will use different paths — see [FAQ → MCP stdio PATH](FAQ).

## Provider quick reference

Astra Dock supports three brain providers — pick one in **⚙ → Agent · Tools & Permissions → Provider**:

| Provider | Best for | Key format | Model picker |
|---|---|---|---|
| **OpenRouter** | Browsing the full model market; mixing free + paid; vision | `sk-or-v1-…` (~73 chars) | Live `/v1/models` catalog with filter chips |
| **Anthropic** | Direct Claude access; lowest-latency tool calls | `sk-ant-api03-…` | Free-form model id field (`claude-sonnet-4-5`, `claude-3-5-haiku`, …) |
| **OpenAI** | Direct GPT access; org-scoped billing | `sk-…` or `sk-proj-…` | Free-form model id field (`gpt-4o-mini`, `gpt-4o`, `gpt-5`, …) |

Tool calling works on all three. Vision works on all three when you pick a vision-capable model.

---

## Remote MCP servers (URL + auth)

These run somewhere else; Astra just talks to them over HTTPS.

### GitHub *(official)*

```
Type:   Remote
id:     github
URL:    https://api.githubcopilot.com/mcp/
Bearer: <a GitHub Personal Access Token>
```

- **Scopes**: `repo` for full repo access. `read:org` if you want org-wide queries. Strip down to `public_repo` if you only need open-source.
- **Common tools**: `list_repositories`, `list_pull_requests`, `get_pull_request`, `get_file_contents`, `create_or_update_file`, `create_issue`, `add_pull_request_review_comment`.
- **Recommended overrides**: keep `create_*` / `add_*` at policy `prompt`. `get_*` / `list_*` are auto by default — fine.

### Notion *(official Notion MCP)*

```
Type:   Remote
id:     notion
URL:    https://mcp.notion.com/mcp
Bearer: <Notion API integration token>
```

- **Setup**: in Notion → **Settings → Connections → Develop or manage integrations** → create an internal integration → copy the token → share specific pages/databases with the integration.
- **Common tools**: `search`, `fetch_page`, `create_page`, `append_block_children`, `query_database`, `update_page`.
- **Overrides**: `create_page` / `update_page` / `append_*` → keep at `prompt`. `search` / `fetch_*` / `query_*` → auto.

### Sentry *(official)*

```
Type:   Remote
id:     sentry
URL:    https://mcp.sentry.dev/sse        # or /mcp depending on org config
Bearer: <Sentry user auth token>
```

- **Scopes needed**: `event:read`, `project:read`, `org:read`. Optional `event:write` for resolving issues.
- **Common tools**: `list_issues`, `get_issue`, `list_events`, `resolve_issue`.
- **Overrides**: `resolve_issue` → `prompt` (writes). Everything else → auto.

### Stripe *(official, read-only by default)*

```
Type:   Remote
id:     stripe
URL:    https://mcp.stripe.com/v1
Bearer: <Stripe restricted API key>
```

- **Tip**: use a Stripe **Restricted Key** (Dashboard → Developers → API keys → Create restricted key) with only the resources you need. NEVER paste a live secret key here.
- **Common tools**: `list_customers`, `list_charges`, `list_subscriptions`, `retrieve_customer`.
- **Overrides**: everything `read` → auto. If you enable write resources on the key, set those tools to `always-prompt`.

### Linear *(community)*

```
Type:   Remote
id:     linear
URL:    https://mcp.linear.app/sse        # current endpoint as of 2026
Bearer: <Linear personal API key>
```

- **Scopes**: read by default; toggle write in Linear's API settings if you want issue creation.
- **Common tools**: `list_issues`, `get_issue`, `create_issue`, `update_issue`, `list_projects`.

### Slack *(community)*

There are multiple Slack MCPs in the wild. The official one is preferred:

```
Type:   Remote
id:     slack
URL:    https://mcp.slack.com/                  # check Slack's current docs
Bearer: <Slack user / app token (xoxp-… or xoxb-…)>
```

- **Scopes** depend on what you want — typically `channels:read`, `channels:history`, `chat:write` for posting (gated behind `prompt`).
- **Common tools**: `list_channels`, `get_channel_history`, `post_message`, `search_messages`.
- **Overrides**: `post_message` MUST stay at `prompt` minimum. Treat send-actions like exec.

---

## Local stdio MCP servers

These spawn as subprocesses on your machine. Astra captures the user's login-shell `PATH` once at startup, but absolute paths are always more reliable.

### Filesystem *(official)*

```
Type:    Local stdio
id:      filesystem
command: /opt/homebrew/bin/npx
args:    -y
         @modelcontextprotocol/server-filesystem
         /Users/<you>/projects/<scoped-folder>
```

- **Common tools**: `read_file`, `write_file`, `list_directory`, `move_file`, `search_files`, `directory_tree`.
- **Critical**: scope the path argument tightly. Do **NOT** point at `$HOME` or `/`. The schema linter chips `path` fields as medium-severity — that warning exists for exactly this reason.
- **Overrides**: keep `write_file` / `move_file` at `prompt`. `read_file` / `list_directory` → auto.

### SQLite *(official)*

```
Type:    Local stdio
id:      sqlite
command: /opt/homebrew/bin/npx
args:    -y
         @modelcontextprotocol/server-sqlite
         /Users/<you>/data/<your-db>.db
```

- **Common tools**: `read_query`, `write_query`, `list_tables`, `describe_table`, `append_insight`.
- **Effect inference**: `write_query` → exec (`always-prompt` by default). Good — don't bypass.

### Postgres *(official)*

```
Type:    Local stdio
id:      postgres
command: /opt/homebrew/bin/npx
args:    -y
         @modelcontextprotocol/server-postgres
         postgresql://USER:PASS@HOST:5432/DBNAME
```

- **Common tools**: `query` (read-only by default).
- **Pro tip**: use a connection string for a read-only Postgres role. Even with read-only access, a SQL query can run arbitrary functions in some DBs — keep it at `prompt`.

### Playwright *(community / Microsoft)*

```
Type:    Local stdio
id:      playwright
command: /opt/homebrew/bin/npx
args:    -y
         @playwright/mcp@latest
```

- **Common tools**: `browser_navigate`, `browser_click`, `browser_fill_form`, `browser_take_screenshot`, `browser_evaluate`.
- **Overrides**: `browser_evaluate` → `always-prompt` (arbitrary JS execution in the page context). Click/fill → `prompt`. Navigate → `auto` is reasonable.
- **Warning**: this gives the agent a real browser. Don't leave it pointed at a logged-in session you don't want it touching.

### Claude Code *(official)*

```
Type:    Local stdio
id:      claude-code
command: /opt/homebrew/bin/claude
args:    mcp
         serve
```

- **Common tools**: `View`, `Edit`, `LS`, `Glob`, `Grep`, `Bash`.
- **Overrides**: `Bash` MUST stay at `always-prompt`. `Edit` at `prompt`. `View` / `LS` / `Grep` / `Glob` → auto.
- **Tip**: when Astra is also running as an MCP server (⚙ → Agent Control Plane), Claude Code can call *back* into Astra for screen capture + approvals. The two together make a powerful "I see what you see, you see what I see" loop.

### Gmail *(community)*

There are several Gmail MCP implementations; the most maintained one as of late 2025 is `@gongrzhe/server-gmail-autoauth-mcp`. Auth is OAuth via a local browser flow on first connect.

```
Type:    Local stdio
id:      gmail
command: /opt/homebrew/bin/npx
args:    -y
         @gongrzhe/server-gmail-autoauth-mcp
```

- **Common tools**: `list_emails`, `search_emails`, `read_email`, `send_email`, `create_draft`, `modify_email`.
- **Overrides**: `send_email` → `always-prompt` (don't bypass). `create_draft` → `prompt`. `read_*` / `list_*` / `search_*` → auto.
- **First run** triggers an OAuth flow. Watch stderr in the server card if the auth window doesn't appear.

### Google Calendar *(community)*

Same OAuth flow pattern as Gmail. As of 2026, `@modelcontextprotocol/server-google-calendar` (community) is the common one.

```
Type:    Local stdio
id:      gcal
command: /opt/homebrew/bin/npx
args:    -y
         @cocal/google-calendar-mcp
```

- **Common tools**: `list_events`, `create_event`, `update_event`, `delete_event`, `find_availability`.
- **Overrides**: `create_*` / `update_*` → `prompt`. `delete_event` → `always-prompt`.

---

## What's NOT recommended

- **Connecting unaudited community MCPs and clicking ＋ Register all with policies set to `auto`.** Read the discovered tool list, look at the schema-linter warning chips on each row, and keep write/exec at `prompt` until you trust the surface.
- **Pointing the filesystem MCP at `/` or `$HOME`.** Scope it to one project directory. The schema linter will flag `path` fields, but the safest mitigation is scope at config time.
- **Putting bearer tokens into the "Additional headers" textarea.** That field is plaintext. The dedicated **Bearer token** field encrypts via `safeStorage` at rest. Always use it.
- **Mixing remote MCPs that share a single PAT.** If one server is compromised, the PAT leaks. Use a separate token per MCP, scoped to the minimum permissions needed.
- **Plaintext HTTP URLs** for anything carrying a real token. Astra will warn on the card; don't dismiss the warning unless you're hitting `http://127.0.0.1/...`.

---

## Your own MCP server

Astra Dock is transport-vanilla. Any conformant **stdio** or **Streamable HTTP** MCP server works. If you ship one for your team:

- HTTP: point at it via the Remote form. Token in the Bearer field, anything else in Additional headers.
- stdio: ship a launcher script with an absolute interpreter path. Local form, command points at the launcher.

If you're building one and want it to play well with Astra's safety model, **structure your tool schemas with `additionalProperties: false`** and avoid generic `command` / `path` / `query` fields without scoping — those trigger the highest-severity linter chips.

---

## Astra-as-server (the inverse direction)

Want Claude Code / Codex / Cursor to call into Astra (for screen capture, user approvals, etc.)? That's ⚙ → **Agent Control Plane**. See [Agent Mode](Agent-Mode) for details on the seven `astra_*` tools exposed and how to copy the right config snippet into your agent.
