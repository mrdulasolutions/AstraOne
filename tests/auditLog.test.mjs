import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createAuditLog,
  hashArgs,
  redactArgs,
  canonicalize,
  isSensitiveKey,
} = require('../src/main/tools/auditLog.js');

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-audit-'));
  return path.join(dir, 'audit.log');
}

test('canonicalize: sorts object keys deterministically', () => {
  const a = canonicalize({ b: 1, a: 2 });
  assert.strictEqual(JSON.stringify(a), '{"a":2,"b":1}');
  // nested
  const n = canonicalize({ x: { z: 3, y: 4 } });
  assert.strictEqual(JSON.stringify(n), '{"x":{"y":4,"z":3}}');
});

test('hashArgs: same content → same hash; reordered keys → same hash', () => {
  const h1 = hashArgs({ a: 1, b: 2 });
  const h2 = hashArgs({ b: 2, a: 1 });
  assert.strictEqual(h1, h2);
  const h3 = hashArgs({ a: 1, b: 3 });
  assert.notStrictEqual(h1, h3);
});

test('isSensitiveKey flags common secret keys across casing styles', () => {
  for (const k of ['api_key', 'apiKey', 'apikey', 'API_KEY', 'password', 'authToken', 'bearer', 'private_key', 'privateKey', 'client_secret', 'clientSecret', 'Authorization']) {
    assert.ok(isSensitiveKey(k), `expected ${k} to match`);
  }
  for (const k of ['prompt', 'message', 'voice_id', 'model_id', 'name', 'authority']) {
    assert.ok(!isSensitiveKey(k), `unexpected match: ${k}`);
  }
});

test('redactArgs: replaces sensitive values; nested + arrays', () => {
  const out = redactArgs({
    api_key: 'sk-real',
    nested: { password: 'pw', name: 'keep' },
    list: [{ token: 't', text: 'fine' }],
  });
  assert.strictEqual(out.api_key, '[REDACTED]');
  assert.strictEqual(out.nested.password, '[REDACTED]');
  assert.strictEqual(out.nested.name, 'keep');
  assert.strictEqual(out.list[0].token, '[REDACTED]');
  assert.strictEqual(out.list[0].text, 'fine');
});

test('createAuditLog: record() appends JSONL with hash-only mode by default', () => {
  const p = tmpPath();
  const log = createAuditLog({ logPath: p });
  log.record({ id: 'a.b', source: 'builtin', args: { api_key: 'sekret', q: 'x' }, status: 'ok', duration_ms: 12, result: 'hi' });
  const raw = fs.readFileSync(p, 'utf8');
  assert.match(raw, /\n$/);
  const parsed = JSON.parse(raw.trim());
  assert.strictEqual(parsed.id, 'a.b');
  assert.ok(parsed.args_hash.length === 64, 'sha256 hex');
  assert.strictEqual(parsed.args, undefined, 'hash-only mode drops args');
  assert.strictEqual(parsed.result_bytes, 2);
  assert.strictEqual(parsed.status, 'ok');
});

test('createAuditLog: redact mode keeps redacted args', () => {
  const p = tmpPath();
  const log = createAuditLog({ logPath: p, redactionMode: 'redact' });
  log.record({ id: 'a.b', source: 'builtin', args: { api_key: 'sekret', q: 'x' } });
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8').trim());
  assert.strictEqual(parsed.args.api_key, '[REDACTED]');
  assert.strictEqual(parsed.args.q, 'x');
});

test('createAuditLog: rotation moves the file to .1 at maxBytes', () => {
  const p = tmpPath();
  const log = createAuditLog({ logPath: p, maxBytes: 200 });
  for (let i = 0; i < 30; i++) {
    log.record({ id: `t.${i}`, source: 'builtin', status: 'ok' });
  }
  const rotated = `${p}.1`;
  assert.ok(fs.existsSync(rotated), 'rotated file should exist');
  const currentSize = fs.statSync(p).size;
  // The current file holds entries written after the rotation; should be < 200 + one record.
  assert.ok(currentSize < 600, `current file too big after rotation: ${currentSize}`);
});

test('createAuditLog: tail returns the last n records in order', () => {
  const p = tmpPath();
  const log = createAuditLog({ logPath: p });
  for (let i = 0; i < 50; i++) {
    log.record({ id: `t.${i}`, source: 'builtin', status: 'ok' });
  }
  const last10 = log.tail(10);
  assert.strictEqual(last10.length, 10);
  assert.strictEqual(last10[0].id, 't.40');
  assert.strictEqual(last10[9].id, 't.49');
});

test('createAuditLog: tail on missing file returns []', () => {
  const p = path.join(os.tmpdir(), 'never-written-' + Date.now(), 'x.log');
  const log = createAuditLog({ logPath: p });
  log.clear();
  assert.deepStrictEqual(log.tail(5), []);
});

test('createAuditLog: clamps duration_ms negative -> 0', () => {
  const p = tmpPath();
  const log = createAuditLog({ logPath: p });
  log.record({ id: 'a', source: 'builtin', duration_ms: -99 });
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8').trim());
  assert.strictEqual(parsed.duration_ms, 0);
});

test('createAuditLog: truncates long error strings', () => {
  const p = tmpPath();
  const log = createAuditLog({ logPath: p });
  log.record({ id: 'a', source: 'builtin', status: 'error', error: 'x'.repeat(800) });
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8').trim());
  assert.strictEqual(parsed.error.length, 500);
});
