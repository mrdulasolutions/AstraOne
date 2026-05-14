'use strict';

/**
 * MCP Client manager (stdio transport).
 *
 * Manages a pool of stdio MCP-server connections, discovered tool catalogs, and
 * — when a user opts in — bridges those tools into the central registry so the
 * agent router can call them like any built-in.
 *
 * Constructed via `createMcpClient(deps)`. All external dependencies are injected
 * (SDK loader, registry, env builder, audit log) so the module is testable without
 * spawning real processes.
 *
 * Server lifecycle:
 *   add → 'disconnected' → connect → 'connecting' → 'connected'
 *                                                ↘ 'error'
 *   connected ↔ disconnect → 'disconnected'
 *   remove → cleans up registered tools + closes transport
 *
 * Tool registration:
 *   A discovered tool stays *outside* the registry until the user explicitly
 *   registers it (via UI). Registered tools live as `mcp.<serverId>.<toolName>`
 *   in the registry with `source: 'mcp'`, `serverId`, an inferred `effect`, and
 *   a handler that proxies through this manager's `callTool`.
 *
 * Stderr capture: each connected server has a ring buffer (last ~5 KB) of stderr
 * lines for debugging. Surfaced via `getStderr(id)`.
 */

const path = require('node:path');
const { inferEffect, lintSchema } = require('./schemaLinter.js');

const VALID_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const MAX_STDERR_BYTES = 5 * 1024;

function createMcpClient(deps = {}) {
  const {
    registry,
    /** Async loader for the SDK so tests can inject a mock. */
    loadSdk = defaultLoadSdk,
    /** (extraEnv?) => env merged with login-shell env, used when spawning. */
    mergedSpawnEnv = (extra = {}) => ({ ...process.env, ...extra }),
    /** Optional auditLog instance. */
    auditLog = null,
    /** Persist callback: (configsArray) => void. Called after add/remove. */
    persistServers = () => {},
    /** Emit status updates back to the renderer. */
    emit = () => {},
  } = deps;

  if (!registry) throw new TypeError('createMcpClient: registry required');

  /** @type {Map<string, ServerEntry>} */
  const servers = new Map();

  // ——— Server CRUD ———

  function validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') throw new TypeError('config must be an object');
    if (typeof cfg.id !== 'string' || !VALID_ID_RE.test(cfg.id)) {
      throw new Error('id must match [A-Za-z][A-Za-z0-9_-]* (no dots/spaces/slashes)');
    }
    if (cfg.type !== 'stdio') {
      throw new Error('only type:"stdio" is supported in this build');
    }
    if (typeof cfg.command !== 'string' || !cfg.command.trim()) {
      throw new Error('command (string) is required');
    }
    if (cfg.args != null && !Array.isArray(cfg.args)) {
      throw new TypeError('args must be an array of strings');
    }
    if (cfg.env != null && (typeof cfg.env !== 'object' || Array.isArray(cfg.env))) {
      throw new TypeError('env must be an object of string→string');
    }
  }

  function add(config) {
    validateConfig(config);
    if (servers.has(config.id)) throw new Error(`server "${config.id}" already exists`);

    const entry = {
      id: config.id,
      config: {
        id: config.id,
        type: 'stdio',
        command: String(config.command).trim(),
        args: Array.isArray(config.args) ? config.args.map(String) : [],
        env: config.env && typeof config.env === 'object' ? { ...config.env } : {},
        enabled: Boolean(config.enabled),
        autoRegister: false, // honored in PR-C; ignored here.
      },
      status: 'disconnected',
      lastError: null,
      client: null,
      transport: null,
      discoveredTools: [],
      stderrRing: [],
      stderrBytes: 0,
    };
    servers.set(config.id, entry);
    persistServers(serializeAll());
    emitStatus(entry);
    return serialize(entry);
  }

  async function remove(id) {
    const entry = servers.get(id);
    if (!entry) return false;
    if (entry.status === 'connected' || entry.status === 'connecting') {
      try { await disconnect(id); } catch {}
    }
    // Unregister any tools we'd added.
    registry.unregisterBy?.((t) => t.source === 'mcp' && t.serverId === id);
    servers.delete(id);
    persistServers(serializeAll());
    emit('mcp:removed', { id });
    return true;
  }

  function list() {
    return [...servers.values()].map(serialize);
  }

  function get(id) {
    const e = servers.get(id);
    return e ? serialize(e) : null;
  }

  function serialize(e) {
    return {
      id: e.id,
      config: { ...e.config },
      status: e.status,
      lastError: e.lastError,
      discoveredTools: e.discoveredTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        effect: t.effect,
        warnings: t.warnings,
        registered: registry.get(`mcp.${e.id}.${t.name}`) != null,
      })),
      isAbsoluteCommand: path.isAbsolute(e.config.command),
    };
  }

  function serializeAll() {
    return [...servers.values()].map((e) => ({ ...e.config }));
  }

  function emitStatus(entry) {
    emit('mcp:status', { id: entry.id, status: entry.status, lastError: entry.lastError });
  }

  function getStderr(id) {
    const e = servers.get(id);
    return e ? e.stderrRing.join('') : '';
  }

  // ——— Connect / disconnect ———

  async function connect(id) {
    const entry = servers.get(id);
    if (!entry) throw new Error(`unknown server: ${id}`);
    if (entry.status === 'connected') return serialize(entry);
    if (entry.status === 'connecting') throw new Error('already connecting');

    entry.status = 'connecting';
    entry.lastError = null;
    entry.stderrRing = [];
    entry.stderrBytes = 0;
    emitStatus(entry);

    let sdk;
    try {
      sdk = await loadSdk();
    } catch (err) {
      entry.status = 'error';
      entry.lastError = `SDK load failed: ${err.message}`;
      emitStatus(entry);
      throw err;
    }

    const { Client, StdioClientTransport } = sdk;

    let stderrSink;
    try {
      const env = mergedSpawnEnv(entry.config.env || {});
      entry.transport = new StdioClientTransport({
        command: entry.config.command,
        args: entry.config.args.slice(),
        env,
        stderr: 'pipe',
      });

      // The SDK gives us a stderr stream we can subscribe to.
      stderrSink = entry.transport.stderr;
      if (stderrSink && typeof stderrSink.on === 'function') {
        stderrSink.on('data', (chunk) => appendStderr(entry, chunk));
      }

      entry.client = new Client(
        { name: 'astra-dock', version: '0.1.0' },
        { capabilities: {} },
      );

      await entry.client.connect(entry.transport);
      const listed = await entry.client.listTools();
      const rawTools = Array.isArray(listed?.tools) ? listed.tools : [];
      entry.discoveredTools = rawTools.map((t) => prepareDiscoveredTool(t));
      entry.status = 'connected';
      emitStatus(entry);
      return serialize(entry);
    } catch (err) {
      entry.status = 'error';
      entry.lastError = String(err?.message || err);
      try { await entry.client?.close?.(); } catch {}
      try { await entry.transport?.close?.(); } catch {}
      entry.client = null;
      entry.transport = null;
      emitStatus(entry);
      throw err;
    }
  }

  async function disconnect(id) {
    const entry = servers.get(id);
    if (!entry) return false;
    // Unregister tools first so an agent run mid-disconnect cannot find stale handlers.
    registry.unregisterBy?.((t) => t.source === 'mcp' && t.serverId === id);
    try { await entry.client?.close?.(); } catch {}
    try { await entry.transport?.close?.(); } catch {}
    entry.client = null;
    entry.transport = null;
    entry.status = 'disconnected';
    entry.lastError = null;
    emitStatus(entry);
    return true;
  }

  function appendStderr(entry, chunk) {
    const s = chunk == null ? '' : (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    if (!s) return;
    entry.stderrRing.push(s);
    entry.stderrBytes += s.length;
    while (entry.stderrBytes > MAX_STDERR_BYTES && entry.stderrRing.length > 1) {
      const drop = entry.stderrRing.shift();
      entry.stderrBytes -= drop.length;
    }
  }

  function prepareDiscoveredTool(t) {
    const name = String(t?.name || '');
    const schema = (t?.inputSchema && typeof t.inputSchema === 'object')
      ? t.inputSchema
      : { type: 'object', properties: {} };
    return {
      name,
      description: String(t?.description || '').slice(0, 600),
      inputSchema: schema,
      effect: inferEffect(name),
      warnings: lintSchema(schema).warnings,
    };
  }

  async function refreshTools(id) {
    const entry = servers.get(id);
    if (!entry || entry.status !== 'connected') {
      throw new Error('server not connected');
    }
    const listed = await entry.client.listTools();
    entry.discoveredTools = (listed?.tools || []).map(prepareDiscoveredTool);
    return entry.discoveredTools.slice();
  }

  // ——— Tool registration into the central registry ———

  function registerTool(serverId, toolName, options = {}) {
    const entry = servers.get(serverId);
    if (!entry) throw new Error(`unknown server: ${serverId}`);
    const discovered = entry.discoveredTools.find((t) => t.name === toolName);
    if (!discovered) throw new Error(`tool "${toolName}" not discovered on "${serverId}"`);

    const effect = options.effect && ['read', 'write', 'exec'].includes(options.effect)
      ? options.effect
      : discovered.effect;

    const registryId = `mcp.${serverId}.${toolName}`;
    if (registry.get(registryId)) return { ok: true, id: registryId, alreadyRegistered: true };

    registry.register({
      id: registryId,
      source: 'mcp',
      serverId,
      effect,
      description: discovered.description || `MCP tool ${toolName} on ${serverId}`,
      jsonSchema: discovered.inputSchema,
      renderPreview: (args) => renderPreview(serverId, toolName, args),
      handler: async (args, ctx) => {
        const e = servers.get(serverId);
        if (!e || e.status !== 'connected') {
          throw new Error(`MCP server "${serverId}" is not connected`);
        }
        // The SDK supports an AbortSignal for callTool; thread it through if present.
        const out = await e.client.callTool(
          { name: toolName, arguments: args || {} },
          undefined,
          ctx?.signal ? { signal: ctx.signal } : undefined,
        );
        return out;
      },
    });

    return { ok: true, id: registryId, alreadyRegistered: false };
  }

  function unregisterTool(serverId, toolName) {
    return registry.unregister(`mcp.${serverId}.${toolName}`);
  }

  function renderPreview(serverId, toolName, args) {
    const argSummary = summarizeArgs(args);
    return argSummary
      ? `Call ${serverId}.${toolName} with: ${argSummary}`
      : `Call ${serverId}.${toolName} (no arguments)`;
  }

  function summarizeArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const pairs = [];
    for (const [k, v] of Object.entries(args)) {
      let display;
      if (typeof v === 'string') display = v.length > 60 ? `${v.slice(0, 57)}…` : v;
      else if (v === null || typeof v === 'number' || typeof v === 'boolean') display = String(v);
      else display = `<${Array.isArray(v) ? 'array' : 'object'}>`;
      pairs.push(`${k}=${display}`);
      if (pairs.join(', ').length > 360) break;
    }
    return pairs.join(', ');
  }

  // ——— Restore from persisted prefs ———

  function loadConfigs(configs) {
    if (!Array.isArray(configs)) return;
    for (const c of configs) {
      try {
        if (!servers.has(c.id)) add(c);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[mcpClient] skipping invalid persisted server "${c?.id}":`, err.message);
      }
    }
  }

  return {
    add,
    remove,
    list,
    get,
    connect,
    disconnect,
    refreshTools,
    registerTool,
    unregisterTool,
    getStderr,
    loadConfigs,
    // exposed for tests
    _internal: { servers, prepareDiscoveredTool },
  };
}

async function defaultLoadSdk() {
  const clientMod = await import('@modelcontextprotocol/sdk/client/index.js');
  const stdioMod = await import('@modelcontextprotocol/sdk/client/stdio.js');
  return { Client: clientMod.Client, StdioClientTransport: stdioMod.StdioClientTransport };
}

module.exports = {
  createMcpClient,
  defaultLoadSdk,
  VALID_ID_RE,
  MAX_STDERR_BYTES,
};
