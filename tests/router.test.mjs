import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRegistry, encodeIdForOpenAI } = require('../src/main/tools/registry.js');
const { createPermissions } = require('../src/main/tools/permissions.js');
const { createRouter, wrapToolOutput } = require('../src/main/agents/router.js');

function makeRegistry(extra = []) {
  const r = createRegistry();
  r.register({
    id: 'astra.capture',
    source: 'builtin',
    effect: 'read',
    description: 'Capture screen',
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    renderPreview: () => 'snap',
    async handler() { return { base64: 'AAAA', meta: { name: 'a window' } }; },
  });
  for (const x of extra) r.register(x);
  return r;
}

function makeRouter({ providerScript, registry, permissions, awaitApproval = async () => 'approve', auditLog = null }) {
  let i = 0;
  const provider = {
    async chat() {
      const step = providerScript[i++];
      if (!step) throw new Error('provider script exhausted');
      return step;
    },
  };
  return createRouter({
    registry,
    permissions,
    auditLog,
    providers: { fake: provider },
    getProviderApiKey: () => 'fake-key',
    awaitApproval,
    getSessionImage: () => null,
    getSystemPrompt: () => 'system',
  });
}

test('router: returns final text when model emits no tool_calls', async () => {
  const registry = makeRegistry();
  const permissions = createPermissions();
  const router = makeRouter({
    providerScript: [{ text: 'hello human', toolCalls: [], finishReason: 'stop' }],
    registry,
    permissions,
  });
  const out = await router.run({ providerId: 'fake', model: 'm', prompt: 'hi' });
  assert.strictEqual(out.text, 'hello human');
  assert.strictEqual(out.iterations, 1);
});

test('router: runs an auto-approved read tool and produces the final text', async () => {
  const registry = makeRegistry();
  const permissions = createPermissions();
  let captured = false;
  const provider = {
    async chat({ messages }) {
      if (!captured) {
        captured = true;
        return {
          text: '',
          toolCalls: [{ id: 'c1', name: encodeIdForOpenAI('astra.capture'), arguments: {} }],
        };
      }
      // Second turn should include the tool_result message.
      const last = messages[messages.length - 1];
      assert.strictEqual(last.role, 'tool_result');
      assert.match(last.content, /<tool_output server="builtin" untrusted>/);
      return { text: 'I see your window', toolCalls: [] };
    },
  };
  const router = createRouter({
    registry,
    permissions,
    providers: { fake: provider },
    getProviderApiKey: () => 'k',
    awaitApproval: async () => 'approve',
  });
  const out = await router.run({ providerId: 'fake', model: 'm', prompt: 'what is on screen' });
  assert.strictEqual(out.text, 'I see your window');
  assert.strictEqual(out.iterations, 2);
});

test('router: emits tool:event phases in order', async () => {
  const registry = makeRegistry();
  const permissions = createPermissions();
  const events = [];
  const provider = {
    callCount: 0,
    async chat() {
      this.callCount++;
      if (this.callCount === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'astra_capture', arguments: {} }] };
      }
      return { text: 'done', toolCalls: [] };
    },
  };
  const router = createRouter({
    registry,
    permissions,
    providers: { fake: provider },
    getProviderApiKey: () => 'k',
    awaitApproval: async () => 'approve',
    emit: (event, payload) => events.push({ event, phase: payload.phase }),
  });
  await router.run({ providerId: 'fake', model: 'm', prompt: 'x' });
  const phases = events.map((e) => e.phase);
  // builtin read is auto-approved, so no awaiting_approval phase
  assert.deepStrictEqual(phases, ['thinking', 'calling', 'result', 'final']);
});

test('router: prompts for approval when policy is prompt and pauses for awaitApproval', async () => {
  const registry = createRegistry();
  registry.register({
    id: 'fs.write_file',
    source: 'mcp',
    serverId: 'fs',
    effect: 'write',
    description: 'Write file',
    jsonSchema: { type: 'object', properties: { path: { type: 'string' } } },
    renderPreview: (a) => `write ${a?.path || ''}`,
    async handler() { return { ok: true }; },
  });
  const permissions = createPermissions();
  let approvalDescriptor = null;
  const provider = {
    callCount: 0,
    async chat() {
      this.callCount++;
      if (this.callCount === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'fs_write_file', arguments: { path: '/tmp/x' } }] };
      }
      return { text: 'wrote it', toolCalls: [] };
    },
  };
  const router = createRouter({
    registry,
    permissions,
    providers: { fake: provider },
    getProviderApiKey: () => 'k',
    awaitApproval: async (d) => { approvalDescriptor = d; return 'approve'; },
  });
  const out = await router.run({ providerId: 'fake', model: 'm', prompt: 'do it' });
  assert.ok(approvalDescriptor, 'awaitApproval should have been called');
  assert.strictEqual(approvalDescriptor.toolId, 'fs.write_file');
  assert.strictEqual(approvalDescriptor.serverId, 'fs');
  assert.strictEqual(approvalDescriptor.effect, 'write');
  assert.strictEqual(approvalDescriptor.previewText, 'write /tmp/x');
  assert.strictEqual(out.text, 'wrote it');
});

test('router: denial returns error tool_result, run continues', async () => {
  const registry = createRegistry();
  registry.register({
    id: 'fs.write_file',
    source: 'mcp',
    serverId: 'fs',
    effect: 'write',
    description: 'Write',
    jsonSchema: { type: 'object', properties: {} },
    async handler() { return { ok: true }; },
  });
  const permissions = createPermissions();
  const provider = {
    callCount: 0,
    async chat({ messages }) {
      this.callCount++;
      if (this.callCount === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'fs_write_file', arguments: {} }] };
      }
      // tool_result should be present and marked as error.
      const last = messages[messages.length - 1];
      assert.strictEqual(last.role, 'tool_result');
      assert.strictEqual(last.isError, true);
      assert.match(last.content, /denied by user/);
      return { text: 'okay, I will not write', toolCalls: [] };
    },
  };
  const router = createRouter({
    registry,
    permissions,
    providers: { fake: provider },
    getProviderApiKey: () => 'k',
    awaitApproval: async () => 'deny',
  });
  const out = await router.run({ providerId: 'fake', model: 'm', prompt: 'do it' });
  assert.strictEqual(out.text, 'okay, I will not write');
});

test('router: unknown tool name produces error tool_result without throwing', async () => {
  const registry = makeRegistry();
  const permissions = createPermissions();
  const provider = {
    callCount: 0,
    async chat({ messages }) {
      this.callCount++;
      if (this.callCount === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'ghost_tool', arguments: {} }] };
      }
      const last = messages[messages.length - 1];
      assert.match(last.content, /unknown tool/);
      return { text: 'pivoting', toolCalls: [] };
    },
  };
  const router = createRouter({
    registry,
    permissions,
    providers: { fake: provider },
    getProviderApiKey: () => 'k',
    awaitApproval: async () => 'approve',
  });
  const out = await router.run({ providerId: 'fake', model: 'm', prompt: 'x' });
  assert.strictEqual(out.text, 'pivoting');
});

test('router: handler exception is recorded as error result and run continues', async () => {
  const registry = createRegistry();
  registry.register({
    id: 'flaky.read',
    source: 'builtin',
    effect: 'read',
    description: 'Flaky',
    jsonSchema: { type: 'object', properties: {} },
    async handler() { throw new Error('kaboom'); },
  });
  const permissions = createPermissions();
  const provider = {
    callCount: 0,
    async chat({ messages }) {
      this.callCount++;
      if (this.callCount === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'flaky_read', arguments: {} }] };
      }
      const last = messages[messages.length - 1];
      assert.match(last.content, /kaboom/);
      return { text: 'recovered', toolCalls: [] };
    },
  };
  const router = createRouter({
    registry,
    permissions,
    providers: { fake: provider },
    getProviderApiKey: () => 'k',
    awaitApproval: async () => 'approve',
  });
  const out = await router.run({ providerId: 'fake', model: 'm', prompt: 'x' });
  assert.strictEqual(out.text, 'recovered');
});

test('router: iteration cap throws when model never stops calling tools', async () => {
  const registry = makeRegistry();
  const permissions = createPermissions();
  const provider = {
    async chat() {
      return { text: '', toolCalls: [{ id: 'c' + Math.random(), name: 'astra_capture', arguments: {} }] };
    },
  };
  const router = createRouter({
    registry,
    permissions,
    providers: { fake: provider },
    getProviderApiKey: () => 'k',
    awaitApproval: async () => 'approve',
    maxIterations: 3,
  });
  await assert.rejects(
    router.run({ providerId: 'fake', model: 'm', prompt: 'x' }),
    /exceeded iteration cap/,
  );
});

test('router: cancel aborts mid-flight', async () => {
  const registry = makeRegistry();
  const permissions = createPermissions();
  const provider = {
    async chat({ signal }) {
      return await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        // never resolve
      });
    },
  };
  const router = createRouter({
    registry,
    permissions,
    providers: { fake: provider },
    getProviderApiKey: () => 'k',
    awaitApproval: async () => 'approve',
  });
  const pending = router.run({ providerId: 'fake', model: 'm', prompt: 'x' });
  setTimeout(() => router.cancel(), 10);
  await assert.rejects(pending, /aborted|cancel/);
});

test('router: rejects starting a second run while one is in flight', async () => {
  const registry = makeRegistry();
  const permissions = createPermissions();
  let resolveFirst;
  const provider = {
    callCount: 0,
    async chat() {
      this.callCount++;
      if (this.callCount === 1) {
        return new Promise((res) => { resolveFirst = res; });
      }
      return { text: 'second', toolCalls: [] };
    },
  };
  const router = createRouter({
    registry,
    permissions,
    providers: { fake: provider },
    getProviderApiKey: () => 'k',
    awaitApproval: async () => 'approve',
  });
  const first = router.run({ providerId: 'fake', model: 'm', prompt: 'a' });
  await assert.rejects(
    router.run({ providerId: 'fake', model: 'm', prompt: 'b' }),
    /already in flight/,
  );
  resolveFirst({ text: 'first', toolCalls: [] });
  const r = await first;
  assert.strictEqual(r.text, 'first');
});

test('wrapToolOutput escapes special chars in server id', () => {
  const wrapped = wrapToolOutput('bad"server', 'x');
  assert.match(wrapped, /<tool_output server="bad_server" untrusted>/);
});
