import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildOpenAIMessages, parseOpenAIResponse } = require(
  '../src/main/providers/openrouter.js',
);

test('openrouter.buildOpenAIMessages: passes system + user text through', () => {
  const out = buildOpenAIMessages([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ]);
  assert.deepStrictEqual(out, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ]);
});

test('openrouter.buildOpenAIMessages: image content becomes image_url part', () => {
  const out = buildOpenAIMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_jpeg_base64', data: 'AAAA' },
      ],
    },
  ]);
  assert.strictEqual(out[0].content[0].type, 'text');
  assert.strictEqual(out[0].content[1].type, 'image_url');
  assert.match(out[0].content[1].image_url.url, /^data:image\/jpeg;base64,AAAA$/);
});

test('openrouter.buildOpenAIMessages: assistant toolCalls serialize to tool_calls', () => {
  const out = buildOpenAIMessages([
    {
      role: 'assistant',
      content: 'checking',
      toolCalls: [{ id: 'call_1', name: 'a_b', arguments: { x: 1 } }],
    },
  ]);
  assert.strictEqual(out[0].role, 'assistant');
  assert.strictEqual(out[0].tool_calls[0].id, 'call_1');
  assert.strictEqual(out[0].tool_calls[0].type, 'function');
  assert.strictEqual(out[0].tool_calls[0].function.name, 'a_b');
  assert.strictEqual(out[0].tool_calls[0].function.arguments, '{"x":1}');
});

test('openrouter.buildOpenAIMessages: tool_result becomes role:tool message', () => {
  const out = buildOpenAIMessages([
    { role: 'tool_result', toolUseId: 'call_1', content: '{"ok":true}' },
  ]);
  assert.deepStrictEqual(out, [
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
  ]);
});

test('openrouter.parseOpenAIResponse: plain text', () => {
  const r = parseOpenAIResponse({
    choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }],
  });
  assert.strictEqual(r.text, 'hello world');
  assert.deepStrictEqual(r.toolCalls, []);
  assert.strictEqual(r.finishReason, 'stop');
});

test('openrouter.parseOpenAIResponse: tool_calls parsed into normalized shape', () => {
  const r = parseOpenAIResponse({
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'a_b', arguments: '{"x":2}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual(r.toolCalls[0].id, 'c1');
  assert.strictEqual(r.toolCalls[0].name, 'a_b');
  assert.deepStrictEqual(r.toolCalls[0].arguments, { x: 2 });
  assert.strictEqual(r.finishReason, 'tool_calls');
});

test('openrouter.parseOpenAIResponse: malformed arguments JSON falls back to {}', () => {
  const r = parseOpenAIResponse({
    choices: [
      {
        message: {
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'x', arguments: 'not json' } },
          ],
        },
      },
    ],
  });
  assert.deepStrictEqual(r.toolCalls[0].arguments, {});
});
