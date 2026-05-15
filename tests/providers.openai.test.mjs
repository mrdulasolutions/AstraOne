import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const openaiProvider = require('../src/main/providers/openai.js');

// The OpenAI provider reuses buildOpenAIMessages + parseOpenAIResponse from
// providers/openrouter.js (covered exhaustively in providers.openrouter.test.mjs).
// These tests focus on the URL + auth path + 429 retry policy.

const ORIGINAL_FETCH = globalThis.fetch;

test.afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

function fakeJsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('openai.chat: POSTs to api.openai.com with Bearer auth', async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return fakeJsonResponse({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    });
  };
  const r = await openaiProvider.chat({
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.strictEqual(captured.url, openaiProvider.OPENAI_CHAT_URL);
  assert.strictEqual(captured.opts.headers.authorization, 'Bearer sk-test');
  assert.strictEqual(captured.opts.headers['OpenAI-Organization'], undefined);
  assert.strictEqual(r.text, 'hi');
});

test('openai.chat: passes tools when provided', async () => {
  let body = null;
  globalThis.fetch = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return fakeJsonResponse({ choices: [{ message: { content: '' } }] });
  };
  await openaiProvider.chat({
    apiKey: 'k',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'capture', parameters: {} } }],
  });
  assert.strictEqual(body.tools.length, 1);
  assert.strictEqual(body.tools[0].function.name, 'capture');
});

test('openai.chat: organization header when supplied', async () => {
  let captured = null;
  globalThis.fetch = async (_url, opts) => {
    captured = opts.headers;
    return fakeJsonResponse({ choices: [{ message: { content: '' } }] });
  };
  await openaiProvider.chat({
    apiKey: 'k',
    model: 'gpt-4o-mini',
    messages: [],
    organization: 'org-abc',
  });
  assert.strictEqual(captured['OpenAI-Organization'], 'org-abc');
});

test('openai.chat: retries once on 429, then succeeds', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
      });
    }
    return fakeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const r = await openaiProvider.chat({
    apiKey: 'k', model: 'gpt-4o-mini', messages: [],
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.text, 'ok');
});

test('openai.chat: gives up on 401 without retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('bad key', { status: 401 });
  };
  await assert.rejects(
    openaiProvider.chat({ apiKey: 'k', model: 'gpt-4o-mini', messages: [] }),
    /OpenAI 401/,
  );
  assert.strictEqual(calls, 1);
});

test('openai.chat: rejects without apiKey or model', async () => {
  await assert.rejects(
    openaiProvider.chat({ model: 'm', messages: [] }),
    /missing API key/,
  );
  await assert.rejects(
    openaiProvider.chat({ apiKey: 'k', messages: [] }),
    /missing model/,
  );
});
