'use strict';

/**
 * Anthropic native provider.
 *
 * Same `chat({apiKey, model, messages, tools, maxTokens, signal})` contract as
 * providers/openrouter.js, but speaks the Anthropic Messages API:
 *   - `system` is a top-level string, not a message.
 *   - Assistant tool calls live in `content` blocks of type 'tool_use'.
 *   - Tool results are sent as user messages with `content` blocks of type 'tool_result'.
 *   - Roles must strictly alternate user/assistant; consecutive tool_results are merged
 *     into one user message.
 *
 * Uses the official `@anthropic-ai/sdk` for transport, retries, and JSON parsing.
 */

const ANTHROPIC_API_VERSION = '2023-06-01';

let SdkCtor = null;
function loadSdk() {
  if (SdkCtor !== null) return SdkCtor;
  try {
    const mod = require('@anthropic-ai/sdk');
    SdkCtor = mod.default || mod.Anthropic || mod;
  } catch (err) {
    throw new Error(`@anthropic-ai/sdk is not installed: ${err.message}`);
  }
  return SdkCtor;
}

/**
 * Convert normalized messages → Anthropic input.
 * Returns { system, messages }.
 */
function buildAnthropicInput(messages) {
  let system = '';
  const out = [];

  for (const m of messages) {
    if (!m || !m.role) continue;

    if (m.role === 'system') {
      system = system ? `${system}\n\n${String(m.content || '')}` : String(m.content || '');
      continue;
    }

    if (m.role === 'user') {
      out.push({ role: 'user', content: toAnthropicUserContent(m.content) });
    } else if (m.role === 'assistant') {
      const blocks = [];
      const text = String(m.content || '');
      if (text) blocks.push({ type: 'text', text });
      if (Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: String(tc.id),
            name: String(tc.name),
            input: typeof tc.arguments === 'object' && tc.arguments ? tc.arguments : {},
          });
        }
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : '' });
    } else if (m.role === 'tool_result') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: String(m.toolUseId),
            content: String(m.content || ''),
            ...(m.isError ? { is_error: true } : {}),
          },
        ],
      });
    }
  }

  return { system, messages: mergeConsecutiveSameRole(out) };
}

/** Anthropic requires strict user/assistant alternation; merge runs of the same role. */
function mergeConsecutiveSameRole(msgs) {
  const merged = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      const a = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content || '') }];
      const b = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
      last.content = [...a, ...b];
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

function toAnthropicUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      out.push({ type: 'text', text: String(part.text || '') });
    } else if (part.type === 'image_jpeg_base64') {
      out.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: String(part.data || '') },
      });
    }
  }
  return out;
}

function parseAnthropicResponse(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const texts = [];
  const toolCalls = [];
  for (const b of blocks) {
    if (b?.type === 'text') texts.push(b.text || '');
    else if (b?.type === 'tool_use') {
      toolCalls.push({
        id: String(b.id),
        name: String(b.name),
        arguments: b.input && typeof b.input === 'object' ? b.input : {},
      });
    }
  }
  return {
    text: texts.join('\n'),
    toolCalls,
    finishReason: String(data?.stop_reason || ''),
    raw: data,
  };
}

/**
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {Array} args.messages
 * @param {Array} [args.tools]   Registry-produced Anthropic tool specs.
 * @param {number} [args.maxTokens=2048]
 * @param {AbortSignal} [args.signal]
 */
async function chat({ apiKey, model, messages, tools, maxTokens = 2048, signal }) {
  if (!apiKey) throw new Error('Anthropic: missing API key');
  if (!model) throw new Error('Anthropic: missing model id');
  const Ctor = loadSdk();
  const client = new Ctor({ apiKey });
  const { system, messages: anth } = buildAnthropicInput(messages);

  const req = {
    model,
    max_tokens: maxTokens,
    messages: anth,
  };
  if (system) req.system = system;
  if (Array.isArray(tools) && tools.length) req.tools = tools;

  // SDK options support `signal` for AbortController.
  const data = await client.messages.create(req, { signal });
  return parseAnthropicResponse(data);
}

module.exports = {
  chat,
  buildAnthropicInput,
  parseAnthropicResponse,
  mergeConsecutiveSameRole,
  ANTHROPIC_API_VERSION,
};
