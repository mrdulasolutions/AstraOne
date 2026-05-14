'use strict';

/**
 * Permissions — resolve whether a tool call needs user approval.
 *
 * Effect vs policy:
 *   - effect: 'read' | 'write' | 'exec'  (intrinsic to the tool)
 *   - policy: 'auto' | 'prompt' | 'always-prompt' (user-controlled, per-tool or per-server)
 *
 * Cross-server escalation:
 *   A `write` (or `exec`) tool call that fires within `crossServerWindow` turns of a tool
 *   *result* from a different server is forced to 'prompt', even if policy is 'auto'.
 *   This mitigates prompt-injection-driven write actions whose context came from elsewhere.
 *
 * Session grants:
 *   `grantServerSession(serverId, durationMs)` records an in-memory expiry. While valid,
 *   any tool from that server with effect 'read' or 'write' resolves to 'auto'. `exec`
 *   tools and tools with policy 'always-prompt' are never auto-granted.
 *
 * This module is pure JS; the caller provides policy lookup functions so prefs storage
 * is decoupled. No Electron / fs imports.
 */

const VALID_POLICIES = new Set(['auto', 'prompt', 'always-prompt']);

const DEFAULT_BY_EFFECT = Object.freeze({
  read: 'auto',
  write: 'prompt',
  exec: 'always-prompt',
});

function createPermissions(opts = {}) {
  const {
    /** (toolId) => 'auto'|'prompt'|'always-prompt'|null  Most-specific policy. */
    getToolPolicy = () => null,
    /** (serverId) => 'auto'|'prompt'|'always-prompt'|null  Per-MCP-server default. */
    getServerPolicy = () => null,
    /** () => 'auto'|'prompt'|'always-prompt'|null  Global override. */
    getGlobalPolicy = () => null,
    /** How many recent turns to inspect for cross-server escalation. */
    crossServerWindow = 2,
    now = Date.now,
  } = opts;

  /** @type {Map<string, number>} serverId -> expiry epoch ms */
  const sessionGrants = new Map();

  function normalize(p) {
    return VALID_POLICIES.has(p) ? p : null;
  }

  function resolvePolicy(tool) {
    return (
      normalize(getToolPolicy(tool.id)) ||
      (tool.serverId ? normalize(getServerPolicy(tool.serverId)) : null) ||
      normalize(getGlobalPolicy()) ||
      DEFAULT_BY_EFFECT[tool.effect] ||
      'prompt'
    );
  }

  function grantServerSession(serverId, durationMs = 15 * 60 * 1000) {
    if (!serverId) return;
    sessionGrants.set(String(serverId), now() + Math.max(0, Number(durationMs) || 0));
  }

  function revokeServerSession(serverId) {
    sessionGrants.delete(String(serverId));
  }

  function isServerGranted(serverId) {
    if (!serverId) return false;
    const exp = sessionGrants.get(String(serverId));
    if (exp == null) return false;
    if (exp <= now()) {
      sessionGrants.delete(String(serverId));
      return false;
    }
    return true;
  }

  function activeGrants() {
    const t = now();
    const out = [];
    for (const [id, exp] of sessionGrants) {
      if (exp > t) out.push({ serverId: id, expiresAt: exp });
      else sessionGrants.delete(id);
    }
    return out;
  }

  /**
   * Decide whether the tool call needs approval.
   *
   * @param {object} args
   * @param {object} args.tool         Registry entry: { id, source, serverId?, effect }
   * @param {string[]} [args.recentServers]  Server ids of recent tool RESULTS, newest first.
   *                                          Used for cross-server escalation on write/exec.
   * @returns {'auto' | 'prompt'}
   */
  function evaluate({ tool, recentServers = [] }) {
    if (!tool || typeof tool !== 'object') {
      throw new TypeError('evaluate: tool object required');
    }
    if (!DEFAULT_BY_EFFECT[tool.effect]) {
      throw new TypeError(`evaluate: unknown tool.effect ${JSON.stringify(tool.effect)}`);
    }

    const policy = resolvePolicy(tool);

    if (policy === 'always-prompt') return 'prompt';

    // Cross-server escalation: write/exec calls following a different server's output
    // require approval even if user said 'auto'.
    if (tool.effect !== 'read') {
      const window = Math.max(0, Number(crossServerWindow) || 0);
      const myServer = tool.serverId || (tool.source === 'builtin' ? '__builtin__' : null);
      for (const otherServer of recentServers.slice(0, window)) {
        if (otherServer && otherServer !== myServer) {
          return 'prompt';
        }
      }
    }

    if (policy === 'prompt') {
      // Per-server session grants can short-circuit prompt → auto, but only for
      // read+write (not exec) and only when policy isn't 'always-prompt' (handled above).
      if (tool.serverId && tool.effect !== 'exec' && isServerGranted(tool.serverId)) {
        return 'auto';
      }
      return 'prompt';
    }

    // policy === 'auto'
    return 'auto';
  }

  return {
    evaluate,
    grantServerSession,
    revokeServerSession,
    isServerGranted,
    activeGrants,
    resolvePolicy,
  };
}

module.exports = {
  createPermissions,
  DEFAULT_BY_EFFECT,
  VALID_POLICIES,
};
