import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createAstraMcpServer,
  generateToken,
  tokenLooksValid,
  originAllowed,
  parseBearer,
  timingSafeEqualStr,
  TOOL_DEFINITIONS,
} = require('../src/main/server/astraMcpServer.js');

// ——— pure helpers ———

test('generateToken: 64 hex chars, randomized', () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notStrictEqual(a, b);
});

test('tokenLooksValid: accepts hex, rejects others', () => {
  assert.strictEqual(tokenLooksValid('a'.repeat(64)), true);
  assert.strictEqual(tokenLooksValid('a'.repeat(31)), false);
  assert.strictEqual(tokenLooksValid('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), false);
  assert.strictEqual(tokenLooksValid(''), false);
  assert.strictEqual(tokenLooksValid(123), false);
});

test('originAllowed: missing or allowlisted', () => {
  assert.strictEqual(originAllowed(undefined), true);
  assert.strictEqual(originAllowed(''), true);
  assert.strictEqual(originAllowed('null'), true);
  assert.strictEqual(originAllowed('http://127.0.0.1'), true);
  assert.strictEqual(originAllowed('http://localhost'), true);
  assert.strictEqual(originAllowed('https://evil.example.com'), false);
  assert.strictEqual(originAllowed('http://attacker.com'), false);
});

test('parseBearer: tolerates whitespace and case', () => {
  assert.strictEqual(parseBearer('Bearer abc123'), 'abc123');
  assert.strictEqual(parseBearer('bearer abc123'), 'abc123');
  assert.strictEqual(parseBearer('Bearer  abc123 '), 'abc123');
  assert.strictEqual(parseBearer('Basic abc'), null);
  assert.strictEqual(parseBearer(undefined), null);
});

test('timingSafeEqualStr: equal strings true, different false', () => {
  assert.strictEqual(timingSafeEqualStr('hello', 'hello'), true);
  assert.strictEqual(timingSafeEqualStr('hello', 'world'), false);
  assert.strictEqual(timingSafeEqualStr('a', 'ab'), false);
});

test('TOOL_DEFINITIONS: covers the documented surface', () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
  assert.deepStrictEqual(names, [
    'astra_ask_about_screen',
    'astra_capture_active_window',
    'astra_capture_primary_screen',
    'astra_get_last_answer',
    'astra_panic_clear_buffer',
    'astra_request_user_approval',
    'astra_show_overlay_message',
  ]);
});

// ——— HTTP integration ———
//
// Spin up the real server on an OS-assigned port and hit it with fetch.

async function startTestServer(opts = {}) {
  const token = opts.token || generateToken();
  let lastRequestAuth = null;
  const handlers = {
    astra_capture_primary_screen: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ meta: { name: 'Primary' } }) }],
    }),
    astra_get_last_answer: async () => ({ content: [{ type: 'text', text: 'last answer ok' }] }),
    astra_show_overlay_message: async ({ text }) => ({ content: [{ type: 'text', text: `shown:${text}` }] }),
    ...(opts.handlers || {}),
  };
  const server = createAstraMcpServer({
    getToken: () => token,
    isToolEnabled: opts.isToolEnabled || (() => true),
    handlers,
  });
  const r = await server.start({ port: 0 }); // 0 = OS-assigned
  return { server, port: r.port, token };
}

async function jsonRpc({ port, token, origin, sessionId, body }) {
  return fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

async function handshakeSession({ port, token }) {
  const res = await jsonRpc({
    port,
    token,
    body: {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    },
  });
  const sid = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
  // drain body so the connection isn't left half-open
  try { await res.text(); } catch {}
  await jsonRpc({
    port, token, sessionId: sid,
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  return sid;
}

test('astra mcp server: rejects 401 without bearer', async () => {
  const { server, port } = await startTestServer();
  try {
    const res = await jsonRpc({ port, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.strictEqual(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /Bearer/);
  } finally {
    await server.stop();
  }
});

test('astra mcp server: rejects 401 with wrong bearer', async () => {
  const { server, port } = await startTestServer();
  try {
    const res = await jsonRpc({
      port,
      token: 'definitely-not-the-right-token',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.strictEqual(res.status, 401);
  } finally {
    await server.stop();
  }
});

test('astra mcp server: rejects 403 with disallowed Origin', async () => {
  const { server, port, token } = await startTestServer();
  try {
    const res = await jsonRpc({
      port,
      token,
      origin: 'https://attacker.example.com',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.strictEqual(res.status, 403);
  } finally {
    await server.stop();
  }
});

test('astra mcp server: accepts Origin=http://127.0.0.1', async () => {
  const { server, port, token } = await startTestServer();
  try {
    // Have to initialize first per MCP spec.
    const initRes = await jsonRpc({
      port,
      token,
      origin: 'http://127.0.0.1',
      body: {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      },
    });
    assert.strictEqual(initRes.status, 200);
  } finally {
    await server.stop();
  }
});

test('astra mcp server: 503 when token not configured', async () => {
  const server = createAstraMcpServer({
    getToken: () => '',
    handlers: {},
  });
  const r = await server.start({ port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${r.port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: '{}',
    });
    assert.strictEqual(res.status, 503);
  } finally {
    await server.stop();
  }
});

test('astra mcp server: lists tools filtered by isToolEnabled', async () => {
  const enabled = new Set(['astra_capture_primary_screen', 'astra_get_last_answer']);
  const { server, port, token } = await startTestServer({
    isToolEnabled: (n) => enabled.has(n),
  });
  try {
    const sid = await handshakeSession({ port, token });
    const res = await jsonRpc({
      port, token, sessionId: sid,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const text = await res.text();
    const names = (text.match(/"name":"(astra_[a-z_]+)"/g) || []).map((m) => m.split('"')[3]).sort();
    assert.deepStrictEqual([...new Set(names)], [...enabled].sort());
  } finally {
    await server.stop();
  }
});

test('astra mcp server: disabled tool returns isError when called', async () => {
  const { server, port, token } = await startTestServer({
    isToolEnabled: (n) => n !== 'astra_panic_clear_buffer',
    handlers: { astra_panic_clear_buffer: async () => 'ok' },
  });
  try {
    const sid = await handshakeSession({ port, token });
    const res = await jsonRpc({
      port, token, sessionId: sid,
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'astra_panic_clear_buffer', arguments: {} },
      },
    });
    const txt = await res.text();
    assert.match(txt, /disabled in Agent Control Plane/);
  } finally {
    await server.stop();
  }
});

test('astra mcp server: enabled tool dispatches to handler', async () => {
  let receivedArgs = null;
  const { server, port, token } = await startTestServer({
    handlers: {
      astra_show_overlay_message: async (args) => {
        receivedArgs = args;
        return { content: [{ type: 'text', text: 'shown' }] };
      },
    },
  });
  try {
    const sid = await handshakeSession({ port, token });
    const res = await jsonRpc({
      port, token, sessionId: sid,
      body: {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'astra_show_overlay_message', arguments: { text: 'hi there' } },
      },
    });
    const txt = await res.text();
    assert.deepStrictEqual(receivedArgs, { text: 'hi there' });
    assert.match(txt, /shown/);
  } finally {
    await server.stop();
  }
});

test('astra mcp server: stop() prevents further requests', async () => {
  const { server, port, token } = await startTestServer();
  await server.stop();
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    }),
    /ECONNREFUSED|fetch failed/,
  );
});
