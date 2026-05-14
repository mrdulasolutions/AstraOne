import test from 'node:test';
import assert from 'node:assert';

function isBlockedCopyleft(licRaw) {
  const s = String(licRaw || '')
    .trim()
    .toUpperCase();
  if (/\bGPL\b/.test(s)) return true;
  if (/\bAGPL\b/.test(s)) return true;
  if (/\bLGPL\b/.test(s)) return true;
  if (s.includes('GNU GENERAL PUBLIC')) return true;
  if (s.includes('GNU AFFERO')) return true;
  if (s.includes('GNU LESSER')) return true;
  return false;
}

test('copyleft detector flags GPL family', () => {
  assert.strictEqual(isBlockedCopyleft('GPL-3.0'), true);
  assert.strictEqual(isBlockedCopyleft('MIT'), false);
  assert.strictEqual(isBlockedCopyleft('Apache-2.0'), false);
  assert.strictEqual(isBlockedCopyleft('LGPL-2.1'), true);
});
