# Connectors

> Status: skeleton. Full snippets land in PR-E.

Astra Dock connects to existing MCP servers — most things you'd want as a "connector" (Gmail, GitHub, Calendar, Slack, etc.) already have official or community MCP implementations. Drop their config into Astra and the agent can use them.

## Recommended right now

These are vetted and work with the security defaults shipping in PR-A / PR-B / PR-C.

### GitHub *(remote)*

```
Type:   Remote
id:     github
URL:    https://api.githubcopilot.com/mcp/
Bearer: <a GitHub PAT with the scopes you need>
```

Common tools: `list_repositories`, `list_pull_requests`, `get_file_contents`, `create_issue`. Set write-class tools to policy `prompt` (the default) until you trust the workflow.

### Filesystem *(local stdio)*

```
Type:    Local stdio
id:      filesystem
command: /opt/homebrew/bin/npx          # adjust for your install
args:    -y
         @modelcontextprotocol/server-filesystem
         /Users/you/projects/myrepo
```

Tools: `read_file`, `write_file`, `list_directory`, `move_file`, `search_files`. Scope the path argument tightly — the schema linter chips `path` fields as medium-severity for exactly this reason.

### SQLite *(local stdio)*

```
Type:    Local stdio
id:      sqlite
command: /opt/homebrew/bin/npx
args:    -y
         @modelcontextprotocol/server-sqlite
         /Users/you/data/app.db
```

`query` and `execute` get inferred as `exec` (default policy `always-prompt`). Don't bypass that.

### Claude Code *(local stdio)*

```
Type:    Local stdio
id:      claude-code
command: /opt/homebrew/bin/claude       # absolute path of the claude CLI
args:    mcp
         serve
```

Exposes Claude Code's `View`, `Edit`, etc. After PR-D, the inverse direction (Claude Code calling into Astra) will also be available.

## Coming in PR-E

A wider catalog with auth setup + scope guidance:

- Notion
- Sentry
- Stripe (read-only)
- Playwright
- Postgres
- Google Calendar (community)
- Gmail (community)
- Slack (community)
- Linear

Each will note: required scopes, auth pattern, expected tool effects, recommended policy overrides.

## Your own MCP server

Astra Dock is transport-vanilla. Any conformant stdio or Streamable HTTP MCP server works. If you ship one for your team, point at it via the Remote form (with a bearer if you've added auth) or the Local form.

## What's NOT recommended

- Connecting unaudited community MCPs and clicking **＋ Register all** with policies set to `auto` — that gives the agent unrestricted access to whatever those tools do. Read the discovered tool list, eyeball the linter warning chips, and keep write/exec policies at `prompt` until you understand the surface.
- Pointing the filesystem MCP at `/` (or your home directory). Scope it to the project you're actively working in.
- Putting MCP bearer tokens into the **Additional headers** textarea. The dedicated **Bearer token** field encrypts them; the headers field stores plaintext.
