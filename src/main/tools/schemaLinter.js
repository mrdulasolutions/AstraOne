'use strict';

/**
 * schemaLinter — produces warnings about a tool's JSON-schema input.
 *
 * Surfaced when a user is about to add an MCP-discovered tool to the registry.
 * The intent is "show me what I'd be granting before I grant it" — not to block.
 *
 * Heuristics (intentionally noisy so users can read and dismiss):
 *   - Field names that look like secrets ('api_key', 'password', 'token', etc.) →
 *     a malicious server could fish for these via the agent.
 *   - String fields named like filesystem paths ('path', 'file', 'directory', etc.) →
 *     the agent might be coaxed into pointing them at $HOME secrets.
 *   - Fields named 'command', 'exec', 'shell', 'eval', 'sql' → execution surface.
 *   - Top-level `additionalProperties: true` (or absent on object schemas) →
 *     looser contract; agent can smuggle extra fields.
 *
 * Outputs: { warnings: [{path, kind, severity, message}, ...] }
 */

const { isSensitiveKey } = require('./auditLog.js');

const PATH_LIKE_NAMES = new Set([
  'path', 'paths', 'file', 'files', 'filepath', 'filename',
  'directory', 'directories', 'dir', 'dirs', 'folder', 'cwd', 'workdir',
]);

const EXEC_LIKE_NAMES = new Set([
  'command', 'cmd', 'exec', 'execute', 'shell', 'script', 'eval', 'sql', 'query',
]);

function lintSchema(schema, opts = {}) {
  const warnings = [];
  if (!schema || typeof schema !== 'object') return { warnings };

  walk(schema, '$', warnings);

  if (schema.type === 'object' || schema.properties) {
    if (schema.additionalProperties === true || schema.additionalProperties == null) {
      warnings.push({
        path: '$',
        kind: 'open-schema',
        severity: 'low',
        message:
          'Top-level schema permits additional properties — the model can supply unlisted fields. ' +
          'Set additionalProperties:false in the upstream server to tighten this.',
      });
    }
  }

  return { warnings };
}

function walk(schema, prefix, warnings) {
  if (!schema || typeof schema !== 'object') return;

  // properties
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, child] of Object.entries(schema.properties)) {
      const childPath = `${prefix}.${name}`;
      classifyField(name, child, childPath, warnings);
      walk(child, childPath, warnings);
    }
  }

  // items
  if (schema.items) {
    if (Array.isArray(schema.items)) {
      schema.items.forEach((it, i) => walk(it, `${prefix}[${i}]`, warnings));
    } else {
      walk(schema.items, `${prefix}[*]`, warnings);
    }
  }

  // oneOf / anyOf / allOf
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[key])) {
      schema[key].forEach((s, i) => walk(s, `${prefix}.${key}[${i}]`, warnings));
    }
  }
}

function classifyField(name, schema, fieldPath, warnings) {
  const lc = String(name || '').toLowerCase();

  if (isSensitiveKey(name)) {
    warnings.push({
      path: fieldPath,
      kind: 'sensitive-field',
      severity: 'high',
      message:
        `Field "${name}" looks like a credential. The model could be coaxed into ` +
        'supplying real secrets here from earlier conversation context. Treat with care.',
    });
  }

  if (PATH_LIKE_NAMES.has(lc) && (schema?.type === 'string' || !schema?.type)) {
    warnings.push({
      path: fieldPath,
      kind: 'path-field',
      severity: 'medium',
      message:
        `Field "${name}" accepts a path. Consider scoping this tool's policy to "prompt" ` +
        'so the agent cannot silently target paths outside the expected directory.',
    });
  }

  if (EXEC_LIKE_NAMES.has(lc)) {
    warnings.push({
      path: fieldPath,
      kind: 'exec-field',
      severity: 'high',
      message:
        `Field "${name}" suggests command/code execution. Strongly recommend keeping ` +
        'this tool at policy "prompt" or "always-prompt".',
    });
  }
}

/**
 * Infer an effect category from a tool name. MCP doesn't carry intrinsic
 * read/write/exec metadata; we guess from the verb and let users override.
 */
function inferEffect(toolName) {
  const n = String(toolName || '').toLowerCase();
  if (/^(read|list|get|search|query|show|fetch|describe|head|stat|inspect|view|find)(?:_|$)/.test(n)) {
    return 'read';
  }
  if (/(exec|execute|run|spawn|invoke|shell|eval|kill|terminate|sql)(?:_|$)/.test(n)) {
    return 'exec';
  }
  if (/(write|create|update|delete|remove|modify|move|rename|patch|push|commit|publish|send|post)(?:_|$)/.test(n)) {
    return 'write';
  }
  // Anything we cannot prove read-only is treated as write for safety.
  return 'write';
}

module.exports = {
  lintSchema,
  inferEffect,
  PATH_LIKE_NAMES,
  EXEC_LIKE_NAMES,
};
