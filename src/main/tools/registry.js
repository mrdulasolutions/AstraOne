'use strict';

/**
 * Tool Registry — the single source of truth for tools available to the agent.
 *
 * A registered tool:
 *   {
 *     id: string                      // dotted name, e.g. "astra.capture_active_window"
 *     source: 'builtin' | 'mcp' | 'astra-server'
 *     serverId?: string               // for source==='mcp', which MCP server provided it
 *     effect: 'read' | 'write' | 'exec'  // intrinsic side-effect class
 *     description: string             // human-readable; also sent to the model
 *     jsonSchema: object              // JSON Schema for the args (draft-07-compatible)
 *     renderPreview?: (args) => string // OPTIONAL: short user-facing preview (~400 chars)
 *     handler: async (args, ctx) => any
 *   }
 *
 * `effect` is intrinsic to the tool; `policy` (handled in permissions.js) is user-controlled.
 * Provider-specific tool shapes are produced via toOpenAIToolSpecs / toAnthropicToolSpecs.
 * Tool RESULTS travel back to the model via encodeResultForOpenAI / encodeResultForAnthropic.
 *
 * This module is pure: no Electron imports, no fs, no network. Handlers receive a ctx
 * that the caller (router.js) constructs, so they can be replaced for testing.
 */

const VALID_SOURCES = new Set(['builtin', 'mcp', 'astra-server']);
const VALID_EFFECTS = new Set(['read', 'write', 'exec']);

function createRegistry() {
  /** @type {Map<string, object>} */
  const tools = new Map();

  function register(spec) {
    if (!spec || typeof spec !== 'object') {
      throw new TypeError('register(spec): spec must be an object');
    }
    if (typeof spec.id !== 'string' || !spec.id.trim()) {
      throw new TypeError('register: id is required (non-empty string)');
    }
    if (!VALID_SOURCES.has(spec.source)) {
      throw new TypeError(`register: source must be one of ${[...VALID_SOURCES].join(', ')}`);
    }
    if (!VALID_EFFECTS.has(spec.effect)) {
      throw new TypeError(`register: effect must be one of ${[...VALID_EFFECTS].join(', ')}`);
    }
    if (typeof spec.description !== 'string' || !spec.description.trim()) {
      throw new TypeError(`register(${spec.id}): description is required`);
    }
    if (!spec.jsonSchema || typeof spec.jsonSchema !== 'object') {
      throw new TypeError(`register(${spec.id}): jsonSchema (object) is required`);
    }
    if (typeof spec.handler !== 'function') {
      throw new TypeError(`register(${spec.id}): handler (async function) is required`);
    }
    if (spec.renderPreview != null && typeof spec.renderPreview !== 'function') {
      throw new TypeError(`register(${spec.id}): renderPreview, if provided, must be a function`);
    }
    if (tools.has(spec.id)) {
      throw new Error(`register(${spec.id}): already registered (unregister first)`);
    }
    tools.set(spec.id, Object.freeze({ ...spec }));
  }

  function unregister(id) {
    return tools.delete(String(id));
  }

  /** Remove every tool with a given source/serverId combo. */
  function unregisterBy(predicate) {
    if (typeof predicate !== 'function') throw new TypeError('unregisterBy: predicate required');
    let removed = 0;
    for (const [id, t] of tools) {
      if (predicate(t)) {
        tools.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  function get(id) {
    return tools.get(String(id));
  }

  function list(filter) {
    const all = [...tools.values()];
    if (typeof filter === 'function') return all.filter(filter);
    return all;
  }

  function size() {
    return tools.size;
  }

  // ——— Provider schema normalization ———

  function toOpenAIToolSpec(spec) {
    // OpenAI / OpenRouter shape: { type: "function", function: { name, description, parameters } }
    // `name` must match `^[a-zA-Z0-9_-]+$`. We replace dots with underscores so "astra.capture_screen"
    // -> "astra_capture_screen". A reverse map keeps the original id reachable.
    return {
      type: 'function',
      function: {
        name: encodeIdForOpenAI(spec.id),
        description: spec.description,
        parameters: spec.jsonSchema,
      },
    };
  }

  function toAnthropicToolSpec(spec) {
    // Anthropic shape: { name, description, input_schema }
    // Same name-encoding rule applies.
    return {
      name: encodeIdForOpenAI(spec.id),
      description: spec.description,
      input_schema: spec.jsonSchema,
    };
  }

  function toOpenAIToolSpecs(filter) {
    return list(filter).map(toOpenAIToolSpec);
  }

  function toAnthropicToolSpecs(filter) {
    return list(filter).map(toAnthropicToolSpec);
  }

  // ——— Result encoders ———
  // Tool results are appended to the message history so the model can read them.
  // Both providers need the result as a string OR structured content blocks.

  function encodeResultForOpenAI(toolCallId, result) {
    return {
      role: 'tool',
      tool_call_id: String(toolCallId),
      content: stringifyResult(result),
    };
  }

  function encodeResultForAnthropic(toolUseId, result, isError) {
    return {
      type: 'tool_result',
      tool_use_id: String(toolUseId),
      content: stringifyResult(result),
      ...(isError ? { is_error: true } : {}),
    };
  }

  return {
    register,
    unregister,
    unregisterBy,
    get,
    list,
    size,
    toOpenAIToolSpec,
    toAnthropicToolSpec,
    toOpenAIToolSpecs,
    toAnthropicToolSpecs,
    encodeResultForOpenAI,
    encodeResultForAnthropic,
  };
}

// ——— helpers exported for tests ———

function encodeIdForOpenAI(id) {
  // OpenAI requires tool name to match ^[a-zA-Z0-9_-]+$. Map dots to underscores.
  // (We never go back the other way — the registry is the source of truth.)
  const safe = String(id).replace(/\./g, '_');
  if (!/^[a-zA-Z0-9_-]+$/.test(safe)) {
    throw new Error(`tool id "${id}" cannot be safely encoded for provider schemas`);
  }
  return safe;
}

function decodeIdFromOpenAI(encoded, registry) {
  // Reverse: walk the registry and find a tool whose encoded id matches.
  for (const t of registry.list()) {
    if (encodeIdForOpenAI(t.id) === encoded) return t.id;
  }
  return null;
}

function stringifyResult(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

module.exports = {
  createRegistry,
  encodeIdForOpenAI,
  decodeIdFromOpenAI,
  stringifyResult,
};
