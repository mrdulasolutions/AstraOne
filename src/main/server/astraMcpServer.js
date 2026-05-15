'use strict';

/**
 * Astra MCP Server.
 *
 * Exposes Astra Dock's overlay capabilities to outside agents (Claude Code,
 * Codex, Cursor, NAS-hosted bots) via the MCP protocol over Streamable HTTP.
 *
 * Defaults to OFF; the user must explicitly enable in ⚙ → Agent Control Plane.
 *
 * Security posture (per the approved plan):
 *   - Binds ONLY to 127.0.0.1 (never 0.0.0.0).
 *   - Requires `Authorization: Bearer <token>`. Token is 256-bit random, encrypted
 *     at rest via safeStorage, never sent to the renderer in plaintext after the
 *     one-time "Reveal" click.
 *   - Validates Origin header per MCP spec to mitigate DNS rebinding:
 *     missing Origin OR exactly one of an allowlist of localhost forms.
 *   - Per-tool enable/disable via deps.isToolEnabled so users can revoke specific
 *     capabilities (e.g. disable panic_clear_buffer so a runaway agent can't wipe
 *     the user's session).
 *
 * Module is testable in isolation — the SDK loader, handlers, and token getter
 * are all injected.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const DEFAULT_PORT = 4317;

const ALLOWED_ORIGINS = new Set([
  'null',
  'http://127.0.0.1',
  'http://localhost',
  // Trailing variants seen in practice:
  'http://127.0.0.1/',
  'http://localhost/',
]);

const TOOL_DEFINITIONS = [
  {
    name: 'astra_capture_primary_screen',
    description:
      "Capture a JPEG thumbnail of the user's primary display via Astra Dock. Returns base64 image data + metadata.",
    effect: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'astra_capture_active_window',
    description:
      "Capture a JPEG thumbnail of the user's foreground window (largest non-Astra) via Astra Dock.",
    effect: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'astra_ask_about_screen',
    description:
      "Ask Astra's chosen LLM a question about what's currently in Astra's session image buffer. Single-shot, no nested tool calls. Returns the assistant's text answer.",
    effect: 'read',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'The question to ask about the screen.' } },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'astra_get_last_answer',
    description:
      "Return the text of Astra's most recent reply panel content, if any. Useful for an outside agent that wants to read what Astra last told the user.",
    effect: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'astra_show_overlay_message',
    description:
      "Surface a short status string in Astra Dock's status chip. Useful for letting the human know an agent is doing work in the background.",
    effect: 'write',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 240 } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'astra_request_user_approval',
    description:
      "Ask the human at Astra Dock to approve a pending action. Surfaces an approval card in the overlay with the provided preview text. Returns { approved: boolean }. Use this before doing anything destructive on the user's behalf.",
    effect: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Short label for the proposed action.' },
        previewText: { type: 'string', description: 'Human-readable preview of what will happen (multi-line OK).' },
        actor: { type: 'string', description: 'Optional: which agent / client is asking. Surfaced in the card.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'astra_panic_clear_buffer',
    description:
      "Wipe Astra's session capture buffer immediately. Equivalent to the user clicking the Panic button.",
    effect: 'write',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 hex chars, 256 bits
}

function tokenLooksValid(t) {
  return typeof t === 'string' && /^[a-f0-9]{32,}$/i.test(t);
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return crypto.timingSafeEqual(ab, bb);
}

function parseBearer(authHeader) {
  if (typeof authHeader !== 'string') return null;
  const m = /^Bearer\s+([^\s]+)\s*$/i.exec(authHeader);
  return m ? m[1] : null;
}

function originAllowed(origin) {
  if (origin == null) return true; // many MCP clients omit Origin
  const v = String(origin).trim();
  if (!v) return true;
  return ALLOWED_ORIGINS.has(v);
}

function createAstraMcpServer(deps = {}) {
  const {
    /** () => Promise<{Server, StreamableHTTPServerTransport, types}> | sync */
    loadSdk = defaultLoadServerSdk,
    /** () => string | '' — current valid bearer token. Re-read on every request so rotation lands. */
    getToken,
    /** (toolName) => boolean — per-tool enable flag, sourced from prefs. */
    isToolEnabled = () => true,
    /** Tool handler bag — each is async and returns the MCP tool-result content array. */
    handlers = {},
    /** Optional logger for stderr. */
    log = () => {},
    /** Test seam — letting us avoid binding a real port in unit tests. */
    listenFn = null,
  } = deps;

  if (typeof getToken !== 'function') {
    throw new TypeError('createAstraMcpServer: deps.getToken (function) required');
  }

  let httpServer = null;
  let port = null;
  let server = null;
  let transport = null;

  function getRunning() {
    return Boolean(httpServer && httpServer.listening);
  }

  async function start({ port: requested = DEFAULT_PORT } = {}) {
    if (getRunning()) return { ok: true, port };

    const sdk = await loadSdk();
    const { Server, StreamableHTTPServerTransport, types } = sdk;

    server = new Server(
      { name: 'astra-dock', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS
        .filter((t) => isToolEnabled(t.name))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }));

    server.setRequestHandler(types.CallToolRequestSchema, async (request) => {
      const name = String(request?.params?.name || '');
      const args = (request?.params?.arguments && typeof request.params.arguments === 'object')
        ? request.params.arguments : {};
      if (!isToolEnabled(name)) {
        return errorResult(`Tool "${name}" is disabled in Agent Control Plane settings.`);
      }
      const handler = handlers[name];
      if (!handler) return errorResult(`Unknown tool: ${name}`);
      try {
        const out = await handler(args);
        return shapeToolResult(out);
      } catch (err) {
        return errorResult(err?.message || String(err));
      }
    });

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);

    httpServer = http.createServer(async (req, res) => {
      try {
        // Localhost-only is enforced by listen(host='127.0.0.1') below — but defense
        // in depth: reject if `req.socket.remoteAddress` is not a loopback addr.
        const ra = req.socket?.remoteAddress || '';
        if (!isLoopback(ra)) {
          deny(res, 403, 'forbidden: non-loopback origin');
          return;
        }
        // CORS preflight: never allow.
        if (req.method === 'OPTIONS') {
          deny(res, 405, 'method not allowed');
          return;
        }
        if (!originAllowed(req.headers.origin)) {
          deny(res, 403, 'forbidden: bad Origin');
          return;
        }
        const expected = getToken();
        if (!expected) {
          deny(res, 503, 'server token not configured');
          return;
        }
        const supplied = parseBearer(req.headers.authorization);
        if (!supplied || !timingSafeEqualStr(supplied, expected)) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="astra-dock"');
          deny(res, 401, 'unauthorized');
          return;
        }
        // Buffer the request body (Streamable HTTP transport can take it pre-parsed).
        const buf = await readBody(req);
        let parsed;
        if (buf.length) {
          try { parsed = JSON.parse(buf.toString('utf8')); }
          catch { return deny(res, 400, 'malformed JSON'); }
        }
        await transport.handleRequest(req, res, parsed);
      } catch (err) {
        log(`[astra-mcp] request error: ${err?.stack || err}`);
        if (!res.headersSent) deny(res, 500, 'internal error');
      }
    });

    if (listenFn) {
      port = await listenFn(httpServer, requested);
    } else {
      port = await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(requested, '127.0.0.1', () => {
          const addr = httpServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : requested);
        });
      });
    }
    return { ok: true, port };
  }

  async function stop() {
    if (!httpServer) return { ok: true };
    await new Promise((resolve) => httpServer.close(() => resolve()));
    try { await transport?.close?.(); } catch {}
    try { await server?.close?.(); } catch {}
    httpServer = null;
    transport = null;
    server = null;
    port = null;
    return { ok: true };
  }

  return {
    start,
    stop,
    getRunning,
    getPort: () => port,
    // exported for tests
    _internal: { TOOL_DEFINITIONS, originAllowed, parseBearer, timingSafeEqualStr, generateToken, tokenLooksValid },
  };
}

function shapeToolResult(out) {
  if (out && typeof out === 'object' && Array.isArray(out.content)) {
    return out; // caller already returned MCP shape
  }
  const text = typeof out === 'string' ? out : safeJson(out);
  return { content: [{ type: 'text', text }] };
}

function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: String(message) }] };
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function isLoopback(addr) {
  if (!addr) return false;
  if (addr === '127.0.0.1' || addr === '::1') return true;
  // ::ffff:127.0.0.1 — IPv4-mapped IPv6 form Node sometimes emits.
  return addr.startsWith('::ffff:127.');
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function deny(res, status, message) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { message, code: status } }));
}

async function defaultLoadServerSdk() {
  const [serverMod, transportMod, typesMod] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  return {
    Server: serverMod.Server,
    StreamableHTTPServerTransport: transportMod.StreamableHTTPServerTransport,
    types: {
      ListToolsRequestSchema: typesMod.ListToolsRequestSchema,
      CallToolRequestSchema: typesMod.CallToolRequestSchema,
    },
  };
}

module.exports = {
  createAstraMcpServer,
  generateToken,
  tokenLooksValid,
  originAllowed,
  parseBearer,
  timingSafeEqualStr,
  TOOL_DEFINITIONS,
  ALLOWED_ORIGINS,
  DEFAULT_PORT,
};
