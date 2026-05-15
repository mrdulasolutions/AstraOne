'use strict';

/**
 * OpenRouter provider (OpenAI-compatible Chat Completions).
 *
 * Exposes a single `chat()` function and a `listModels()` cache-helper. Handles tool
 * calling per OpenAI's spec: `tools` parameter accepts `{type:"function", function:{...}}`
 * descriptors; responses come back with `choices[0].message.tool_calls`.
 *
 * Normalized message format used internally (caller provides this; we convert):
 *   { role: 'system'|'user'|'assistant'|'tool_result', ... }
 *
 *   user content can be:
 *     - string
 *     - Array<{type:'text',text} | {type:'image_jpeg_base64',data}>
 *
 *   assistant message may carry `toolCalls: [{id, name, arguments}]` — we serialize
 *   it to the OpenAI shape internally.
 *
 *   tool_result is sent as a separate message of role:'tool' (OpenAI shape).
 */

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const REFERER = 'https://github.com/mrdulasolutions/AstraOne';
const TITLE = 'Astra Dock';

function buildOpenAIMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    if (m.role === 'system') {
      out.push({ role: 'system', content: String(m.content || '') });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: toUserContent(m.content) });
    } else if (m.role === 'assistant') {
      const am = { role: 'assistant', content: String(m.content || '') };
      if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
        am.tool_calls = m.toolCalls.map((tc) => ({
          id: String(tc.id),
          type: 'function',
          function: {
            name: String(tc.name),
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
          },
        }));
      }
      out.push(am);
    } else if (m.role === 'tool_result') {
      out.push({
        role: 'tool',
        tool_call_id: String(m.toolUseId),
        content: String(m.content || ''),
      });
    }
  }
  return out;
}

function toUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'text') return { type: 'text', text: String(part.text || '') };
    if (part.type === 'image_jpeg_base64') {
      return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${part.data}` } };
    }
    return null;
  }).filter(Boolean);
}

/**
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {Array} args.messages
 * @param {Array} [args.tools]     Registry-produced OpenAI tool specs.
 * @param {number} [args.maxTokens=2048]
 * @param {AbortSignal} [args.signal]
 */
async function chat({ apiKey, model, messages, tools, maxTokens = 2048, signal }) {
  if (!apiKey) throw new Error('OpenRouter: missing API key');
  if (!model) throw new Error('OpenRouter: missing model id');
  const body = {
    model,
    max_tokens: maxTokens,
    messages: buildOpenAIMessages(messages),
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  // Up to 2 attempts on 429 / 503 with a short backoff before propagating.
  const attempts = [0, 1500];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] > 0) {
      await new Promise((r) => setTimeout(r, attempts[i]));
      if (signal?.aborted) throw new Error('aborted');
    }
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': REFERER,
        'X-OpenRouter-Title': TITLE,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      return parseOpenAIResponse(data);
    }
    const t = await res.text();
    lastErr = new Error(`OpenRouter ${res.status}: ${t.slice(0, 600)}`);
    lastErr.status = res.status;
    lastErr.bodyText = t;
    // Only retry on transient rate-limit / overload.
    if (res.status !== 429 && res.status !== 503) break;
  }
  throw lastErr;
}

function parseOpenAIResponse(data) {
  const choice = data?.choices?.[0] || {};
  const msg = choice.message || {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((tc) => {
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(tc.function?.arguments || '{}'); } catch { parsedArgs = {}; }
      return {
        id: String(tc.id),
        name: String(tc.function?.name || ''),
        arguments: parsedArgs,
      };
    })
    : [];
  return {
    text,
    toolCalls,
    finishReason: String(choice.finish_reason || ''),
    raw: data,
  };
}

async function listModels({ signal } = {}) {
  const res = await fetch(OPENROUTER_MODELS_URL, {
    signal,
    headers: { 'HTTP-Referer': REFERER, 'X-OpenRouter-Title': TITLE },
  });
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
  return res.json();
}

module.exports = {
  chat,
  listModels,
  // exported for tests
  buildOpenAIMessages,
  parseOpenAIResponse,
  OPENROUTER_CHAT_URL,
  OPENROUTER_MODELS_URL,
};
