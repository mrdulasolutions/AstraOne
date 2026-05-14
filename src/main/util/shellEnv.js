'use strict';

/**
 * shellEnv — resolve the user's login-shell environment.
 *
 * When Electron is launched from the Finder/Dock (instead of from a terminal), it
 * inherits a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that does NOT include
 * Homebrew (`/opt/homebrew/bin`), nvm shims, or other developer tools the user
 * has set up in `.zshrc` / `.bashrc`. MCP servers are commonly launched via `npx`,
 * `node`, or `python3` — all of which live in those missing directories.
 *
 * This module:
 *   1. Spawns the user's login shell once (in interactive-login mode so rc files
 *      run), captures `env`, and parses it.
 *   2. Caches the result for the lifetime of the process.
 *   3. Exposes both the captured env and a helper that merges it with the current
 *      process env (the captured values winning for keys like PATH).
 *
 * Safe-failure mode: if the shell invocation fails (e.g. exotic shell, no shell
 * configured, timeout), returns the current `process.env` and logs a warning.
 */

const { execSync } = require('node:child_process');

let cachedEnv = null;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000;

const DEFAULT_SHELL_CANDIDATES = ['/bin/zsh', '/bin/bash', '/bin/sh'];

function quoteForShell(s) {
  // Single-quote escape: end the quote, escape the embedded ', re-open the quote.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Capture the user's login-shell env. Cached for `CACHE_MS`.
 * @returns {Object<string, string>}
 */
function getLoginShellEnv() {
  if (cachedEnv && Date.now() - cachedAt < CACHE_MS) return cachedEnv;

  const shell = pickShell();
  if (!shell) {
    cachedEnv = { ...process.env };
    cachedAt = Date.now();
    return cachedEnv;
  }

  try {
    // `-i` interactive + `-l` login so the user's full rc chain runs (.zprofile,
    // .zshrc, .bash_profile, .bashrc, depending on shell).
    // We emit env as NUL-delimited entries with a marker, so values containing
    // newlines don't corrupt parsing.
    const cmd = `${quoteForShell(shell)} -ilc 'printf "__ASTRA_ENV_MARKER__"; env -0'`;
    const out = execSync(cmd, {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: '/bin/sh',
    });
    const marker = out.indexOf('__ASTRA_ENV_MARKER__');
    if (marker < 0) throw new Error('marker not found in shell env output');
    const raw = out.slice(marker + '__ASTRA_ENV_MARKER__'.length);
    const env = {};
    for (const entry of raw.split('\0')) {
      if (!entry) continue;
      const eq = entry.indexOf('=');
      if (eq < 0) continue;
      const key = entry.slice(0, eq);
      const value = entry.slice(eq + 1);
      if (key) env[key] = value;
    }
    cachedEnv = env;
    cachedAt = Date.now();
    return env;
  } catch (err) {
    // Note to logs (one line) and fall back.
    // eslint-disable-next-line no-console
    console.warn('[shellEnv] login shell capture failed, using process.env:', err.message);
    cachedEnv = { ...process.env };
    cachedAt = Date.now();
    return cachedEnv;
  }
}

function pickShell() {
  const fromEnv = process.env.SHELL;
  if (fromEnv) return fromEnv;
  const fs = require('node:fs');
  for (const candidate of DEFAULT_SHELL_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/**
 * Return an env suitable for spawning a child process: starts from the current
 * process.env, overlays the login-shell env (login shell wins on PATH/HOME/etc.),
 * then overlays the caller's `extra` (caller wins).
 */
function mergedSpawnEnv(extra = {}) {
  const shellEnv = getLoginShellEnv();
  return { ...process.env, ...shellEnv, ...extra };
}

function clearCache() {
  cachedEnv = null;
  cachedAt = 0;
}

module.exports = {
  getLoginShellEnv,
  mergedSpawnEnv,
  clearCache,
  // exported for tests
  pickShell,
  quoteForShell,
};
