import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRegistry, encodeIdForOpenAI, decodeIdFromOpenAI, stringifyResult } = require(
  '../src/main/tools/registry.js',
);

function makeSpec(over = {}) {
  return {
    id: 'astra.capture_active_window',
    source: 'builtin',
    effect: 'read',
    description: 'Capture the foreground window',
    jsonSchema: { type: 'object', properties: {} },
    async handler() { return { base64: 'AAA', meta: {} }; },
    ...over,
  };
}

test('registry: register/list/get/size round-trip', () => {
  const r = createRegistry();
  r.register(makeSpec());
  assert.strictEqual(r.size(), 1);
  assert.ok(r.get('astra.capture_active_window'));
  assert.strictEqual(r.list()[0].effect, 'read');
});

test('registry: register rejects bad sources / effects / missing fields', () => {
  const r = createRegistry();
  assert.throws(() => r.register(makeSpec({ source: 'rogue' })), /source/);
  assert.throws(() => r.register(makeSpec({ effect: 'launch_nukes' })), /effect/);
  assert.throws(() => r.register(makeSpec({ id: '' })), /id/);
  assert.throws(() => r.register(makeSpec({ description: '' })), /description/);
  assert.throws(() => r.register(makeSpec({ handler: undefined })), /handler/);
  assert.throws(() => r.register(makeSpec({ renderPreview: 'not a fn' })), /renderPreview/);
});

test('registry: duplicate id is rejected', () => {
  const r = createRegistry();
  r.register(makeSpec());
  assert.throws(() => r.register(makeSpec()), /already registered/);
});

test('registry: unregister and unregisterBy', () => {
  const r = createRegistry();
  r.register(makeSpec({ id: 'a.one' }));
  r.register(makeSpec({ id: 'a.two', source: 'mcp', serverId: 's1' }));
  r.register(makeSpec({ id: 'a.three', source: 'mcp', serverId: 's2' }));
  assert.strictEqual(r.unregisterBy((t) => t.serverId === 's1'), 1);
  assert.strictEqual(r.size(), 2);
  assert.ok(r.unregister('a.one'));
  assert.strictEqual(r.size(), 1);
});

test('registry: OpenAI tool spec — dots become underscores', () => {
  const r = createRegistry();
  r.register(makeSpec());
  const [spec] = r.toOpenAIToolSpecs();
  assert.strictEqual(spec.type, 'function');
  assert.strictEqual(spec.function.name, 'astra_capture_active_window');
  assert.strictEqual(spec.function.description, 'Capture the foreground window');
  assert.deepStrictEqual(spec.function.parameters, { type: 'object', properties: {} });
});

test('registry: Anthropic tool spec uses input_schema', () => {
  const r = createRegistry();
  r.register(makeSpec());
  const [spec] = r.toAnthropicToolSpecs();
  assert.strictEqual(spec.name, 'astra_capture_active_window');
  assert.ok(spec.input_schema);
  assert.strictEqual(spec.input_schema.type, 'object');
});

test('registry: list filter narrows results', () => {
  const r = createRegistry();
  r.register(makeSpec({ id: 'a.read', effect: 'read' }));
  r.register(makeSpec({ id: 'a.write', effect: 'write' }));
  const writes = r.toOpenAIToolSpecs((t) => t.effect === 'write');
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].function.name, 'a_write');
});

test('registry: encodeResultForOpenAI returns role:tool envelope', () => {
  const r = createRegistry();
  const env = r.encodeResultForOpenAI('call_123', { foo: 'bar' });
  assert.strictEqual(env.role, 'tool');
  assert.strictEqual(env.tool_call_id, 'call_123');
  assert.strictEqual(env.content, '{"foo":"bar"}');
});

test('registry: encodeResultForAnthropic returns tool_result block', () => {
  const r = createRegistry();
  const env = r.encodeResultForAnthropic('toolu_abc', 'plain text');
  assert.strictEqual(env.type, 'tool_result');
  assert.strictEqual(env.tool_use_id, 'toolu_abc');
  assert.strictEqual(env.content, 'plain text');
  assert.strictEqual(env.is_error, undefined);
});

test('registry: encodeResultForAnthropic marks errors', () => {
  const r = createRegistry();
  const env = r.encodeResultForAnthropic('toolu_abc', 'boom', true);
  assert.strictEqual(env.is_error, true);
});

test('registry: decodeIdFromOpenAI round-trips', () => {
  const r = createRegistry();
  r.register(makeSpec({ id: 'github.list_prs' }));
  assert.strictEqual(decodeIdFromOpenAI('github_list_prs', r), 'github.list_prs');
  assert.strictEqual(decodeIdFromOpenAI('missing_tool', r), null);
});

test('registry: stringifyResult handles strings, objects, nulls', () => {
  assert.strictEqual(stringifyResult(null), '');
  assert.strictEqual(stringifyResult('hi'), 'hi');
  assert.strictEqual(stringifyResult({ a: 1 }), '{"a":1}');
});

test('registry: encodeIdForOpenAI rejects invalid chars', () => {
  assert.throws(() => encodeIdForOpenAI('bad name!'), /cannot be safely encoded/);
});
