import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAnthropicInput, parseAnthropicResponse, mergeConsecutiveSameRole } = require(
  '../src/main/providers/anthropic.js',
);

test('anthropic.buildAnthropicInput: system becomes top-level string, not a message', () => {
  const { system, messages } = buildAnthropicInput([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ]);
  assert.strictEqual(system, 'be brief');
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].role, 'user');
});

test('anthropic.buildAnthropicInput: multiple system messages concat with blank line', () => {
  const { system } = buildAnthropicInput([
    { role: 'system', content: 'first' },
    { role: 'system', content: 'second' },
    { role: 'user', content: 'hi' },
  ]);
  assert.strictEqual(system, 'first\n\nsecond');
});

test('anthropic.buildAnthropicInput: image becomes image content block', () => {
  const { messages } = buildAnthropicInput([
    { role: 'user', content: [{ type: 'image_jpeg_base64', data: 'XYZ' }] },
  ]);
  const block = messages[0].content[0];
  assert.strictEqual(block.type, 'image');
  assert.strictEqual(block.source.type, 'base64');
  assert.strictEqual(block.source.media_type, 'image/jpeg');
  assert.strictEqual(block.source.data, 'XYZ');
});

test('anthropic.buildAnthropicInput: assistant toolCalls become tool_use blocks', () => {
  const { messages } = buildAnthropicInput([
    {
      role: 'assistant',
      content: 'thinking',
      toolCalls: [{ id: 'tu_1', name: 'a_b', arguments: { x: 1 } }],
    },
  ]);
  assert.strictEqual(messages[0].role, 'assistant');
  assert.strictEqual(messages[0].content[0].type, 'text');
  assert.strictEqual(messages[0].content[1].type, 'tool_use');
  assert.strictEqual(messages[0].content[1].id, 'tu_1');
  assert.strictEqual(messages[0].content[1].name, 'a_b');
  assert.deepStrictEqual(messages[0].content[1].input, { x: 1 });
});

test('anthropic.buildAnthropicInput: tool_result lives in a user message', () => {
  const { messages } = buildAnthropicInput([
    { role: 'tool_result', toolUseId: 'tu_1', content: '{"ok":true}' },
  ]);
  assert.strictEqual(messages[0].role, 'user');
  assert.strictEqual(messages[0].content[0].type, 'tool_result');
  assert.strictEqual(messages[0].content[0].tool_use_id, 'tu_1');
  assert.strictEqual(messages[0].content[0].content, '{"ok":true}');
});

test('anthropic.buildAnthropicInput: tool_result with isError sets is_error', () => {
  const { messages } = buildAnthropicInput([
    { role: 'tool_result', toolUseId: 'tu_1', content: 'oops', isError: true },
  ]);
  assert.strictEqual(messages[0].content[0].is_error, true);
});

test('anthropic.mergeConsecutiveSameRole: merges adjacent same-role messages', () => {
  const out = mergeConsecutiveSameRole([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '1' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '2' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].role, 'user');
  assert.strictEqual(out[0].content.length, 2);
  assert.strictEqual(out[0].content[0].tool_use_id, 'a');
  assert.strictEqual(out[0].content[1].tool_use_id, 'b');
});

test('anthropic.parseAnthropicResponse: text blocks joined, tool_use captured', () => {
  const r = parseAnthropicResponse({
    content: [
      { type: 'text', text: 'I will call a tool.' },
      { type: 'tool_use', id: 'tu_1', name: 'a_b', input: { x: 9 } },
    ],
    stop_reason: 'tool_use',
  });
  assert.strictEqual(r.text, 'I will call a tool.');
  assert.strictEqual(r.toolCalls.length, 1);
  assert.deepStrictEqual(r.toolCalls[0], { id: 'tu_1', name: 'a_b', arguments: { x: 9 } });
  assert.strictEqual(r.finishReason, 'tool_use');
});

test('anthropic.parseAnthropicResponse: handles missing content gracefully', () => {
  const r = parseAnthropicResponse({});
  assert.strictEqual(r.text, '');
  assert.deepStrictEqual(r.toolCalls, []);
});
