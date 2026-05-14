import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lintSchema, inferEffect } = require('../src/main/tools/schemaLinter.js');

test('lintSchema: flags sensitive field names with severity high', () => {
  const { warnings } = lintSchema({
    type: 'object',
    properties: {
      api_key: { type: 'string' },
      authToken: { type: 'string' },
      normalField: { type: 'string' },
    },
    additionalProperties: false,
  });
  const sensitive = warnings.filter((w) => w.kind === 'sensitive-field');
  assert.strictEqual(sensitive.length, 2, 'should catch api_key and authToken');
  for (const w of sensitive) assert.strictEqual(w.severity, 'high');
});

test('lintSchema: flags path-like fields with severity medium', () => {
  const { warnings } = lintSchema({
    type: 'object',
    properties: {
      path: { type: 'string' },
      filename: { type: 'string' },
      cwd: { type: 'string' },
      name: { type: 'string' },
    },
    additionalProperties: false,
  });
  const paths = warnings.filter((w) => w.kind === 'path-field');
  assert.strictEqual(paths.length, 3);
  for (const w of paths) assert.strictEqual(w.severity, 'medium');
});

test('lintSchema: flags exec-like fields with severity high', () => {
  const { warnings } = lintSchema({
    type: 'object',
    properties: {
      command: { type: 'string' },
      sql: { type: 'string' },
      safe: { type: 'string' },
    },
    additionalProperties: false,
  });
  const execs = warnings.filter((w) => w.kind === 'exec-field');
  assert.strictEqual(execs.length, 2);
});

test('lintSchema: warns about open schemas at the top level', () => {
  const { warnings } = lintSchema({
    type: 'object',
    properties: { x: { type: 'string' } },
    // additionalProperties omitted -> defaults to permissive in JSON Schema
  });
  const opens = warnings.filter((w) => w.kind === 'open-schema');
  assert.strictEqual(opens.length, 1);
});

test('lintSchema: descends into nested properties and arrays', () => {
  const { warnings } = lintSchema({
    type: 'object',
    properties: {
      nested: {
        type: 'object',
        properties: { password: { type: 'string' } },
      },
      list: {
        type: 'array',
        items: { type: 'object', properties: { token: { type: 'string' } } },
      },
    },
    additionalProperties: false,
  });
  const sensitive = warnings.filter((w) => w.kind === 'sensitive-field');
  assert.strictEqual(sensitive.length, 2);
});

test('inferEffect: read for read/list/get/search', () => {
  for (const n of ['read_file', 'list_files', 'get_user', 'search_messages', 'show_status', 'describe_table']) {
    assert.strictEqual(inferEffect(n), 'read', `expected read for ${n}`);
  }
});

test('inferEffect: exec for exec/run/sql', () => {
  for (const n of ['execute_query', 'run_command', 'shell_exec', 'eval_js', 'kill_process']) {
    assert.strictEqual(inferEffect(n), 'exec', `expected exec for ${n}`);
  }
});

test('inferEffect: write for write/create/delete/update', () => {
  for (const n of ['write_file', 'create_issue', 'delete_branch', 'update_record', 'send_message', 'push_commit']) {
    assert.strictEqual(inferEffect(n), 'write', `expected write for ${n}`);
  }
});

test('inferEffect: unknown verbs default to write (safer)', () => {
  assert.strictEqual(inferEffect('mystery_action'), 'write');
  assert.strictEqual(inferEffect(''), 'write');
});
