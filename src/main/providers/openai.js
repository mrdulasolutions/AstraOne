'use strict';

/**
 * OpenAI native provider — same `chat({apiKey, model, messages, tools, …})`
 * contract as `providers/openrouter.js` and `providers/anthropic.js`, but talks
 * directly to OpenAI's API.
 *
 * Why have this when OpenRouter already proxies OpenAI? Two reasons:
 *  1. Some users prefer a direct billing relationship with OpenAI.
 *  2. New OpenAI features (e.g. responses API, certain model rollouts) land on
 *     api.openai.com before OpenRouter's proxy normalizes them.
 *
 * Message conversion + response parsing reuse the OpenAI-shape helpers from
 * providers/openrouter.js so behavior is identical across both clients — only
 * the URL and headers differ.
 */

const { buildOpenAIMessages, parseOpenAIResponse } = require('./openrouter.js');

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.model        — e.g. 'gpt-4o-mini', 'gpt-4.1', 'gpt-5'
 * @param {Array}  args.messages
 * @param {Array}  [args.tools]      — Registry-produced OpenAI tool specs
 * @param {number} [args.maxTokens=2048]
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.organization] — Optional OpenAI-Organization header
 */
async function chat({ apiKey, model, messages, tools, maxTokens = 2048, signal, organization }) {
  if (!apiKey) throw new Error('OpenAI: missing API key');
  if (!model) throw new Error('OpenAI: missing model id');

  const body = {
    model,
    max_tokens: maxTokens,
    messages: buildOpenAIMessages(messages),
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  // Retry once on 429/503, same policy as the OpenRouter provider.
  const attempts = [0, 1500];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] > 0) {
      await new Promise((r) => setTimeout(r, attempts[i]));
      if (signal?.aborted) throw new Error('aborted');
    }
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    };
    if (organization) headers['OpenAI-Organization'] = String(organization);
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      return parseOpenAIResponse(data);
    }
    const t = await res.text();
    lastErr = new Error(`OpenAI ${res.status}: ${t.slice(0, 600)}`);
    lastErr.status = res.status;
    lastErr.bodyText = t;
    if (res.status !== 429 && res.status !== 503) break;
  }
  throw lastErr;
}

module.exports = {
  chat,
  OPENAI_CHAT_URL,
};
