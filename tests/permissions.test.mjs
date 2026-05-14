import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPermissions, DEFAULT_BY_EFFECT } = require('../src/main/tools/permissions.js');

function tool(over = {}) {
  return { id: 't.one', source: 'mcp', serverId: 's1', effect: 'read', ...over };
}

test('permissions: default-by-effect — read auto, write prompt, exec always-prompt', () => {
  assert.strictEqual(DEFAULT_BY_EFFECT.read, 'auto');
  assert.strictEqual(DEFAULT_BY_EFFECT.write, 'prompt');
  assert.strictEqual(DEFAULT_BY_EFFECT.exec, 'always-prompt');

  const p = createPermissions();
  assert.strictEqual(p.evaluate({ tool: tool({ effect: 'read' }) }), 'auto');
  assert.strictEqual(p.evaluate({ tool: tool({ effect: 'write' }) }), 'prompt');
  assert.strictEqual(p.evaluate({ tool: tool({ effect: 'exec' }) }), 'prompt');
});

test('permissions: per-tool policy overrides default', () => {
  const p = createPermissions({
    getToolPolicy: (id) => (id === 't.one' ? 'auto' : null),
  });
  assert.strictEqual(p.evaluate({ tool: tool({ effect: 'write' }) }), 'auto');
});

test('permissions: per-server policy overrides default but not per-tool', () => {
  const p = createPermissions({
    getServerPolicy: (sid) => (sid === 's1' ? 'auto' : null),
  });
  assert.strictEqual(p.evaluate({ tool: tool({ effect: 'write' }) }), 'auto');

  const p2 = createPermissions({
    getToolPolicy: () => 'prompt',
    getServerPolicy: () => 'auto',
  });
  assert.strictEqual(p2.evaluate({ tool: tool({ effect: 'write' }) }), 'prompt');
});

test('permissions: always-prompt is sticky', () => {
  const p = createPermissions({
    getToolPolicy: () => 'always-prompt',
  });
  assert.strictEqual(p.evaluate({ tool: tool({ effect: 'read' }) }), 'prompt');
  p.grantServerSession('s1');
  assert.strictEqual(
    p.evaluate({ tool: tool({ effect: 'read' }) }),
    'prompt',
    'session grant must not break always-prompt',
  );
});

test('permissions: session grant lets prompt-policy tools auto-run', () => {
  const p = createPermissions({ getToolPolicy: () => 'prompt' });
  assert.strictEqual(p.evaluate({ tool: tool({ effect: 'write' }) }), 'prompt');
  p.grantServerSession('s1');
  assert.strictEqual(p.evaluate({ tool: tool({ effect: 'write' }) }), 'auto');
});

test('permissions: session grant never auto-runs exec tools', () => {
  const p = createPermissions();
  p.grantServerSession('s1');
  assert.strictEqual(p.evaluate({ tool: tool({ effect: 'exec' }) }), 'prompt');
});

test('permissions: session grant expires', () => {
  let t = 1000;
  const p = createPermissions({
    getToolPolicy: () => 'prompt',
    now: () => t,
  });
  p.grantServerSession('s1', 5000);
  assert.strictEqual(p.evaluate({ tool: tool({ effect: 'write' }) }), 'auto');
  t = 7000;
  assert.strictEqual(p.evaluate({ tool: tool({ effect: 'write' }) }), 'prompt');
});

test('permissions: cross-server escalation forces prompt on write/exec', () => {
  const p = createPermissions({
    getToolPolicy: () => 'auto',
  });
  // Read is never escalated.
  assert.strictEqual(
    p.evaluate({ tool: tool({ effect: 'read' }), recentServers: ['s2'] }),
    'auto',
  );
  // Write after foreign server output → prompt.
  assert.strictEqual(
    p.evaluate({ tool: tool({ effect: 'write' }), recentServers: ['s2'] }),
    'prompt',
  );
  // Write after same server's output → still auto.
  assert.strictEqual(
    p.evaluate({ tool: tool({ effect: 'write' }), recentServers: ['s1'] }),
    'auto',
  );
});

test('permissions: cross-server window is configurable', () => {
  const p = createPermissions({
    getToolPolicy: () => 'auto',
    crossServerWindow: 1,
  });
  // Only the most recent server counts.
  assert.strictEqual(
    p.evaluate({ tool: tool({ effect: 'write' }), recentServers: ['s1', 's2'] }),
    'auto',
  );
});

test('permissions: builtin tools use a synthetic server id', () => {
  const p = createPermissions({ getToolPolicy: () => 'auto' });
  // A builtin write after a different server's output should still escalate.
  assert.strictEqual(
    p.evaluate({
      tool: { id: 'b.write', source: 'builtin', effect: 'write' },
      recentServers: ['s1'],
    }),
    'prompt',
  );
  // A builtin write after no foreign servers stays auto.
  assert.strictEqual(
    p.evaluate({
      tool: { id: 'b.write', source: 'builtin', effect: 'write' },
      recentServers: [],
    }),
    'auto',
  );
});

test('permissions: revoke + activeGrants', () => {
  const p = createPermissions();
  p.grantServerSession('s1');
  p.grantServerSession('s2');
  assert.strictEqual(p.activeGrants().length, 2);
  p.revokeServerSession('s1');
  assert.strictEqual(p.activeGrants().length, 1);
});

test('permissions: evaluate rejects bad input', () => {
  const p = createPermissions();
  assert.throws(() => p.evaluate({}), /tool object required/);
  assert.throws(
    () => p.evaluate({ tool: { id: 'x', effect: 'nope' } }),
    /unknown tool.effect/,
  );
});
