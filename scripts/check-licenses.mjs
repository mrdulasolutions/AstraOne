#!/usr/bin/env node
/**
 * Verify direct dependencies only (app + electron + tooling) — avoids false
 * positives from transitive media/toolchain packages under Electron.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'node_modules', 'license-checker', 'bin', 'license-checker');

function normalizeLicense(lic) {
  if (!lic) return 'UNKNOWN';
  if (typeof lic === 'string') return lic.trim();
  if (Array.isArray(lic)) return lic.map((x) => String(x).trim()).join(' OR ');
  return String(lic).trim();
}

function isBlockedCopyleft(licRaw) {
  const s = normalizeLicense(licRaw).toUpperCase();
  if (/\bGPL\b/.test(s)) return true;
  if (/\bAGPL\b/.test(s)) return true;
  if (/\bLGPL\b/.test(s)) return true;
  if (s.includes('GNU GENERAL PUBLIC')) return true;
  if (s.includes('GNU AFFERO')) return true;
  if (s.includes('GNU LESSER')) return true;
  return false;
}

const r = spawnSync(process.execPath, [bin, '--direct', '--json', '--start', root], {
  encoding: 'utf8',
  cwd: root,
});

if (r.error) {
  console.error(r.error);
  process.exit(1);
}
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(r.status || 1);
}

let pkg;
try {
  pkg = JSON.parse(r.stdout || '{}');
} catch {
  console.error('license-checker did not return JSON');
  process.exit(1);
}

const bad = [];
for (const [name, info] of Object.entries(pkg)) {
  if (isBlockedCopyleft(info.licenses)) bad.push({ name, licenses: info.licenses });
}

if (bad.length) {
  console.error('Copyleft in direct dependencies:\n', JSON.stringify(bad, null, 2));
  process.exit(1);
}

console.log('License check passed (direct dependencies only).');
