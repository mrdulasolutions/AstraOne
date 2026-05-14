'use strict';

/**
 * Audit Log — append-only JSONL of every tool call.
 *
 * Each record:
 *   {
 *     ts: ISO 8601 string,
 *     id: tool id,
 *     source: 'builtin' | 'mcp' | 'astra-server',
 *     serverId?: string,
 *     args_hash: sha256 hex of canonicalized args,
 *     args?: redacted args object (only when redactionMode === 'redact'),
 *     approver: 'auto' | 'user' | 'session-grant',
 *     result_bytes: number,
 *     duration_ms: number,
 *     status: 'ok' | 'denied' | 'error',
 *     error?: string,
 *   }
 *
 * Rotation: when the active file exceeds `maxBytes`, rename to `${path}.1` (overwriting any
 * previous .1) and start a fresh file. Keeps one rotation generation (10 MB by default).
 *
 * Sensitive arg redaction: keys whose name matches `SENSITIVE_KEY_RE` are replaced with
 * '[REDACTED]'. In `redactionMode === 'hash-only'` (default), args are dropped entirely
 * and only `args_hash` remains. Set to `'redact'` to keep redacted args for debugging.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SENSITIVE_TOKENS = [
  'apikey',
  'password',
  'passwd',
  'secret',
  'token',
  'bearer',
  'authorization',
  'auth',
  'privatekey',
  'clientsecret',
];

/**
 * Returns true if a key name *looks like* a credential field. Handles snake_case,
 * camelCase, and kebab-case by normalizing to lower alphanumeric tokens before matching.
 *   isSensitiveKey('api_key') === true
 *   isSensitiveKey('authToken') === true
 *   isSensitiveKey('Authorization') === true
 *   isSensitiveKey('voice_id') === false
 */
function isSensitiveKey(key) {
  if (key == null) return false;
  const normalized = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  const parts = normalized.split('_').filter(Boolean);
  // Match if any individual token equals a sensitive token (so we don't false-positive
  // on substrings like "authority" containing "auth").
  for (const part of parts) {
    if (SENSITIVE_TOKENS.includes(part)) return true;
  }
  // Also match joined forms like "apikey" (no separator).
  const joined = parts.join('');
  for (const t of ['apikey', 'privatekey', 'clientsecret']) {
    if (joined.includes(t)) return true;
  }
  return false;
}

function canonicalize(obj) {
  // Stable JSON: sort object keys recursively. Arrays/primitives left as-is.
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = canonicalize(obj[k]);
  }
  return out;
}

function hashArgs(args) {
  const c = canonicalize(args == null ? null : args);
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(c));
  return h.digest('hex');
}

function redactArgs(args) {
  if (args === null || typeof args !== 'object') return args;
  if (Array.isArray(args)) return args.map(redactArgs);
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (isSensitiveKey(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      out[k] = redactArgs(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function byteLength(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Buffer.isBuffer(value)) return value.length;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function createAuditLog(opts = {}) {
  const {
    logPath,
    maxBytes = 10 * 1024 * 1024,
    redactionMode = 'hash-only', // 'hash-only' | 'redact'
    now = () => new Date(),
  } = opts;

  if (!logPath || typeof logPath !== 'string') {
    throw new TypeError('createAuditLog: logPath (string) is required');
  }

  // Ensure parent dir exists.
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  function rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      return;
    }
    if (size <= maxBytes) return;
    const rotated = `${logPath}.1`;
    try {
      fs.renameSync(logPath, rotated);
    } catch (err) {
      // If rename fails (file already replaced, race), just truncate.
      try { fs.truncateSync(logPath, 0); } catch {}
    }
  }

  /**
   * Append a record. Returns the written record (after redaction) for callers that
   * want to surface it in UI.
   */
  function record(entry) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('record: entry object required');
    }
    rotateIfNeeded();

    const args = entry.args;
    const hash = hashArgs(args);
    const baseline = {
      ts: (now()).toISOString(),
      id: String(entry.id || ''),
      source: String(entry.source || ''),
      serverId: entry.serverId ? String(entry.serverId) : undefined,
      args_hash: hash,
      approver: String(entry.approver || 'auto'),
      result_bytes: Number(entry.result_bytes ?? byteLength(entry.result)) || 0,
      duration_ms: Math.max(0, Math.round(Number(entry.duration_ms) || 0)),
      status: String(entry.status || 'ok'),
    };
    if (entry.error) baseline.error = String(entry.error).slice(0, 500);
    if (redactionMode === 'redact' && args != null) {
      baseline.args = redactArgs(args);
    }

    const line = JSON.stringify(baseline) + '\n';
    fs.appendFileSync(logPath, line);
    return baseline;
  }

  /**
   * Return the most recent `n` records (newest last in the returned array — same order
   * they were written). Cheap implementation: read whole file. Acceptable for 10 MB.
   */
  function tail(n = 20) {
    let raw = '';
    try {
      raw = fs.readFileSync(logPath, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n').filter(Boolean);
    const slice = lines.slice(-Math.max(1, Math.floor(Number(n) || 20)));
    return slice
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  }

  function clear() {
    try { fs.truncateSync(logPath, 0); } catch {}
  }

  return { record, tail, clear, hashArgs, redactArgs };
}

module.exports = {
  createAuditLog,
  hashArgs,
  redactArgs,
  isSensitiveKey,
  SENSITIVE_TOKENS,
  canonicalize,
};
