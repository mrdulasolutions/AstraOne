import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { createRegistry } = require('../src/main/tools/registry.js');
const { createMcpClient } = require('../src/main/tools/mcpClient.js');

// ——— Mock SDK ———
//
// Mimics the bits of @modelcontextprotocol/sdk that mcpClient.js uses:
//   - Client(name/version, capabilities): connect / listTools / callTool / close
//   - StdioClientTransport(opts): close + a stderr EventEmitter
//
// Tests configure the script ahead of time via `mockToolsByCommand` and
// `mockCallResults`. spawn-style failures are simulated by throwing in connect().

function makeMockSdk({ failConnect = false, toolsList = [], callResults = {}, slowConnect = false } = {}) {
  let lastTransport = null;

  class StdioClientTransport {
    constructor(opts) {
      this.opts = opts;
      this.stderr = new EventEmitter();
      this.closed = false;
      lastTransport = this;
    }
    async close() { this.closed = true; }
  }

  class Client {
    constructor(info, caps) { this.info = info; this.caps = caps; this.closed = false; }
    async connect(transport) {
      this.transport = transport;
      if (failConnect) throw new Error('mock connect failure');
      if (slowConnect) await new Promise((r) => setTimeout(r, 30));
    }
    async listTools() {
      return { tools: toolsList };
    }
    async callTool({ name, arguments: args }, _schema, opts) {
      if (opts?.signal?.aborted) throw new Error('aborted');
      const r = callResults[name];
      if (typeof r === 'function') return r(args);
      if (r instanceof Error) throw r;
      return r ?? { content: [{ type: 'text', text: `result from ${name}` }] };
    }
    async close() { this.closed = true; }
  }

  return {
    sdk: { Client, StdioClientTransport },
    introspect: { getLastTransport: () => lastTransport },
  };
}

function freshSetup(sdkOpts) {
  const registry = createRegistry();
  const mock = makeMockSdk(sdkOpts);
  const events = [];
  const persisted = { value: [] };
  const client = createMcpClient({
    registry,
    loadSdk: async () => mock.sdk,
    mergedSpawnEnv: (extra) => ({ MOCK: '1', ...extra }),
    persistServers: (configs) => { persisted.value = configs; },
    emit: (channel, payload) => events.push({ channel, payload }),
  });
  return { registry, client, events, persisted, mock };
}

test('mcpClient: add validates stdio config', () => {
  const { client } = freshSetup();
  assert.throws(() => client.add({ id: '', type: 'stdio', command: 'x' }), /id/);
  assert.throws(() => client.add({ id: 'bad id', type: 'stdio', command: 'x' }), /id/);
  assert.throws(() => client.add({ id: 'ok', type: 'rogue', command: 'x' }), /type/);
  assert.throws(() => client.add({ id: 'ok', type: 'stdio' }), /command/);
  assert.throws(() => client.add({ id: 'ok', type: 'stdio', command: 'x', args: 'not array' }), /args/);
  assert.throws(() => client.add({ id: 'ok', type: 'stdio', command: 'x', env: 'no' }), /env/);
});

test('mcpClient: add stores config and emits status; list returns serialized', () => {
  const { client, events, persisted } = freshSetup();
  const s = client.add({ id: 'fs', type: 'stdio', command: '/abs/path/npx', args: ['-y', 'pkg'] });
  assert.strictEqual(s.id, 'fs');
  assert.strictEqual(s.status, 'disconnected');
  assert.strictEqual(s.isAbsoluteCommand, true);
  assert.strictEqual(persisted.value[0].command, '/abs/path/npx');
  assert.ok(events.some((e) => e.channel === 'mcp:status' && e.payload.status === 'disconnected'));
});

test('mcpClient: add rejects duplicate ids', () => {
  const { client } = freshSetup();
  client.add({ id: 'fs', type: 'stdio', command: 'npx' });
  assert.throws(() => client.add({ id: 'fs', type: 'stdio', command: 'npx' }), /already exists/);
});

test('mcpClient: connect → connected, discovers tools, runs effect inference + linter', async () => {
  const { client } = freshSetup({
    toolsList: [
      {
        name: 'read_file',
        description: 'read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
      },
      {
        name: 'execute_command',
        description: 'run a shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } }, additionalProperties: false },
      },
    ],
  });
  client.add({ id: 'fs', type: 'stdio', command: '/usr/local/bin/npx' });
  const r = await client.connect('fs');
  assert.strictEqual(r.status, 'connected');
  assert.strictEqual(r.discoveredTools.length, 2);
  const readTool = r.discoveredTools.find((t) => t.name === 'read_file');
  assert.strictEqual(readTool.effect, 'read');
  assert.ok(readTool.warnings.some((w) => w.kind === 'path-field'));
  const execTool = r.discoveredTools.find((t) => t.name === 'execute_command');
  assert.strictEqual(execTool.effect, 'exec');
  assert.ok(execTool.warnings.some((w) => w.kind === 'exec-field'));
});

test('mcpClient: connect failure transitions to error with lastError', async () => {
  const { client } = freshSetup({ failConnect: true });
  client.add({ id: 'fs', type: 'stdio', command: 'npx' });
  await assert.rejects(client.connect('fs'), /mock connect failure/);
  const g = client.get('fs');
  assert.strictEqual(g.status, 'error');
  assert.match(g.lastError, /mock connect failure/);
});

test('mcpClient: registerTool adds a registry entry with source:mcp + serverId + handler', async () => {
  const { client, registry } = freshSetup({
    toolsList: [
      {
        name: 'read_file',
        description: 'read',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    callResults: {
      read_file: (args) => ({ content: [{ type: 'text', text: `read ${args?.path}` }] }),
    },
  });
  client.add({ id: 'fs', type: 'stdio', command: '/usr/local/bin/npx' });
  await client.connect('fs');
  const res = client.registerTool('fs', 'read_file');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.id, 'mcp.fs.read_file');
  const t = registry.get('mcp.fs.read_file');
  assert.ok(t);
  assert.strictEqual(t.source, 'mcp');
  assert.strictEqual(t.serverId, 'fs');
  assert.strictEqual(t.effect, 'read');
  // Handler proxies through the mock client.
  const out = await t.handler({ path: '/tmp/x' }, {});
  assert.deepStrictEqual(out.content[0], { type: 'text', text: 'read /tmp/x' });
});

test('mcpClient: registerTool is idempotent', async () => {
  const { client } = freshSetup({
    toolsList: [{ name: 'noop', description: '', inputSchema: { type: 'object' } }],
  });
  client.add({ id: 's', type: 'stdio', command: 'x' });
  await client.connect('s');
  const a = client.registerTool('s', 'noop');
  assert.strictEqual(a.alreadyRegistered, false);
  const b = client.registerTool('s', 'noop');
  assert.strictEqual(b.alreadyRegistered, true);
});

test('mcpClient: disconnect closes transport and removes registered tools', async () => {
  const { client, registry, mock } = freshSetup({
    toolsList: [{ name: 'noop', description: '', inputSchema: { type: 'object' } }],
  });
  client.add({ id: 's', type: 'stdio', command: 'x' });
  await client.connect('s');
  client.registerTool('s', 'noop');
  assert.ok(registry.get('mcp.s.noop'));
  await client.disconnect('s');
  assert.strictEqual(registry.get('mcp.s.noop'), undefined, 'tool should be unregistered on disconnect');
  assert.strictEqual(client.get('s').status, 'disconnected');
  assert.strictEqual(mock.introspect.getLastTransport().closed, true);
});

test('mcpClient: remove disconnects and purges tools', async () => {
  const { client, registry } = freshSetup({
    toolsList: [{ name: 'noop', description: '', inputSchema: { type: 'object' } }],
  });
  client.add({ id: 's', type: 'stdio', command: 'x' });
  await client.connect('s');
  client.registerTool('s', 'noop');
  const ok = await client.remove('s');
  assert.strictEqual(ok, true);
  assert.strictEqual(client.get('s'), null);
  assert.strictEqual(registry.get('mcp.s.noop'), undefined);
});

test('mcpClient: handler rejects when server is not connected', async () => {
  const { client, registry } = freshSetup({
    toolsList: [{ name: 'noop', description: '', inputSchema: { type: 'object' } }],
  });
  client.add({ id: 's', type: 'stdio', command: 'x' });
  await client.connect('s');
  client.registerTool('s', 'noop');
  const tool = registry.get('mcp.s.noop');
  await client.disconnect('s');
  // After disconnect, the registry entry is gone — but make sure the handler closure
  // also defends against being called against a disconnected entry.
  // Re-register the entry directly to bypass cleanup and prove the guard fires.
  registry.register(tool);
  await assert.rejects(tool.handler({}, {}), /not connected/);
});

test('mcpClient: loadConfigs restores servers from persisted state', () => {
  const { client, persisted } = freshSetup();
  client.loadConfigs([
    { id: 'a', type: 'stdio', command: '/usr/bin/npx', args: ['-y', 'pkg'], env: {}, enabled: true },
    { id: 'b', type: 'stdio', command: 'relative', args: [], env: {}, enabled: false },
  ]);
  assert.strictEqual(client.list().length, 2);
  // Persisted should also reflect after loadConfigs (since each add fires persistServers).
  assert.strictEqual(persisted.value.length, 2);
});

test('mcpClient: refreshTools requires connection', async () => {
  const { client } = freshSetup();
  client.add({ id: 's', type: 'stdio', command: 'x' });
  await assert.rejects(client.refreshTools('s'), /not connected/);
});

test('mcpClient: getStderr returns captured chunks', async () => {
  const { client, mock } = freshSetup({
    toolsList: [],
  });
  client.add({ id: 's', type: 'stdio', command: 'x' });
  await client.connect('s');
  const transport = mock.introspect.getLastTransport();
  transport.stderr.emit('data', Buffer.from('stderr line 1\n', 'utf8'));
  transport.stderr.emit('data', 'stderr line 2\n');
  const captured = client.getStderr('s');
  assert.match(captured, /stderr line 1/);
  assert.match(captured, /stderr line 2/);
});

// ——— HTTP transport ———

function makeHttpMockSdk({ failConnect = false, toolsList = [] } = {}) {
  let lastTransport = null;
  class StreamableHTTPClientTransport {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      lastTransport = this;
    }
    async close() { this.closed = true; }
  }
  class Client {
    constructor(info) { this.info = info; }
    async connect(t) { this.transport = t; if (failConnect) throw new Error('http connect failed'); }
    async listTools() { return { tools: toolsList }; }
    async callTool() { return { content: [] }; }
    async close() { this.closed = true; }
  }
  return {
    sdk: { Client, StreamableHTTPClientTransport },
    introspect: { getLastTransport: () => lastTransport },
  };
}

test('mcpClient: rejects http config with bad url', () => {
  const { createRegistry } = require('../src/main/tools/registry.js');
  const { createMcpClient } = require('../src/main/tools/mcpClient.js');
  const client = createMcpClient({
    registry: createRegistry(),
    loadSdk: async () => ({}),
  });
  assert.throws(() => client.add({ id: 'r', type: 'http' }), /url/);
  assert.throws(() => client.add({ id: 'r', type: 'http', url: 'ftp://x' }), /https?/);
});

test('mcpClient: rejects http config with non-object headers', () => {
  const { createRegistry } = require('../src/main/tools/registry.js');
  const { createMcpClient } = require('../src/main/tools/mcpClient.js');
  const client = createMcpClient({ registry: createRegistry(), loadSdk: async () => ({}) });
  assert.throws(
    () => client.add({ id: 'r', type: 'http', url: 'https://x/mcp', headers: 'no' }),
    /headers/,
  );
});

test('mcpClient: http add → serialize hides bearerToken, exposes presence flag', () => {
  const { createRegistry } = require('../src/main/tools/registry.js');
  const { createMcpClient } = require('../src/main/tools/mcpClient.js');
  const client = createMcpClient({ registry: createRegistry(), loadSdk: async () => ({}) });
  const out = client.add({
    id: 'gh',
    type: 'http',
    url: 'https://api.example.com/mcp',
    bearerToken: 'super-secret',
    headers: { 'X-Org': '1' },
  });
  assert.strictEqual(out.type, 'http');
  assert.strictEqual(out.hasBearerToken, true);
  assert.strictEqual(out.config.bearerToken, undefined, 'bearerToken must not leak to renderer');
  assert.strictEqual(out.config.headers['X-Org'], '1');
});

test('mcpClient: http connect uses StreamableHTTPClientTransport with headers + bearer', async () => {
  const { createRegistry } = require('../src/main/tools/registry.js');
  const { createMcpClient } = require('../src/main/tools/mcpClient.js');
  const registry = createRegistry();
  const mock = makeHttpMockSdk({
    toolsList: [{ name: 'list_repos', description: '', inputSchema: { type: 'object' } }],
  });
  const client = createMcpClient({
    registry,
    loadSdk: async (type) => {
      assert.strictEqual(type, 'http');
      return mock.sdk;
    },
  });
  client.add({
    id: 'gh',
    type: 'http',
    url: 'https://api.example.com/mcp',
    bearerToken: 'tok',
    headers: { 'X-Org': '1' },
  });
  const r = await client.connect('gh');
  assert.strictEqual(r.status, 'connected');
  const t = mock.introspect.getLastTransport();
  assert.strictEqual(t.url.toString(), 'https://api.example.com/mcp');
  assert.strictEqual(t.opts.requestInit.headers['Authorization'], 'Bearer tok');
  assert.strictEqual(t.opts.requestInit.headers['X-Org'], '1');
});

test('mcpClient: http connect with no bearerToken omits Authorization header', async () => {
  const { createRegistry } = require('../src/main/tools/registry.js');
  const { createMcpClient } = require('../src/main/tools/mcpClient.js');
  const mock = makeHttpMockSdk();
  const client = createMcpClient({
    registry: createRegistry(),
    loadSdk: async () => mock.sdk,
  });
  client.add({ id: 'open', type: 'http', url: 'https://api.example.com/mcp' });
  await client.connect('open');
  const t = mock.introspect.getLastTransport();
  assert.strictEqual(t.opts.requestInit.headers['Authorization'], undefined);
});

test('mcpClient: http connect failure → error status with lastError', async () => {
  const { createRegistry } = require('../src/main/tools/registry.js');
  const { createMcpClient } = require('../src/main/tools/mcpClient.js');
  const mock = makeHttpMockSdk({ failConnect: true });
  const client = createMcpClient({
    registry: createRegistry(),
    loadSdk: async () => mock.sdk,
  });
  client.add({ id: 'gh', type: 'http', url: 'https://api.example.com/mcp' });
  await assert.rejects(client.connect('gh'), /http connect failed/);
  const g = client.get('gh');
  assert.strictEqual(g.status, 'error');
});
