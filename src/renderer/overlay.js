const $ = (id) => document.getElementById(id);

let resizeDebounce = null;

const PROMPT_MAX_HEIGHT = 200;
const PROMPT_LINE_MIN = 38;

/** Auto-grow prompt: stays one line until text wraps, then expands up to max height. */
function syncPromptSize() {
  const ta = $('prompt');
  if (!ta || ta.tagName !== 'TEXTAREA') return;
  ta.style.height = 'auto';
  const fullScroll = ta.scrollHeight;
  const h = Math.min(Math.max(fullScroll, PROMPT_LINE_MIN), PROMPT_MAX_HEIGHT);
  ta.style.height = `${h}px`;
  const expanded = h > PROMPT_LINE_MIN + 6;
  ta.classList.toggle('pill-prompt--expanded', expanded);
  ta.style.overflowY = fullScroll > PROMPT_MAX_HEIGHT ? 'auto' : 'hidden';
  scheduleResizeToPill();
}

/** True size of the pill + reply panel (not capped by the current window — avoids a shrink feedback loop). */
function measurePillContentSize() {
  const shell = document.querySelector('.pill-shell') || document.querySelector('.glass-pill');
  if (!shell) return null;
  const bleed = 40;
  const w = Math.ceil(shell.scrollWidth + bleed);
  const h = Math.ceil(Math.max(shell.offsetHeight, shell.scrollHeight) + bleed);
  return { width: w, height: h };
}

/** Shrink OS window to hug the pill; uses scrollWidth so we never clip the full toolbar. */
function scheduleResizeToPill() {
  if (!$('pillView') || $('pillView').classList.contains('is-hidden')) return;
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const size = measurePillContentSize();
        if (!size || !window.glass.resizeToContent) return;
        void window.glass.resizeToContent(size);
      });
    });
  }, 60);
}

function setReply(text) {
  const el = $('reply');
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  el.textContent = s.length > 60 ? `${s.slice(0, 57)}…` : s;
  el.title = s.length > 60 ? s : '';
  scheduleResizeToPill();
}

function showAnswer(text) {
  const panel = $('replyPanel');
  const body = $('replyBody');
  if (!panel || !body) return;
  body.textContent = String(text || '');
  panel.classList.remove('is-hidden');
  scheduleResizeToPill();
  if (ttsAutoSpeak && text && text.trim()) {
    void speakAnswer(text);
  }
}

function clearAnswer() {
  stopTts();
  const panel = $('replyPanel');
  if (!panel) return;
  panel.classList.add('is-hidden');
  const body = $('replyBody');
  if (body) body.textContent = '';
  scheduleResizeToPill();
}

// ——— Approval card + tool events ———

function shortToolName(id) {
  if (!id) return '';
  const parts = id.split('.');
  return parts[parts.length - 1] || id;
}

function showApprovalCard(descriptor) {
  pendingApproval = descriptor;
  const card = $('approvalCard');
  if (!card) return;
  card.dataset.effect = descriptor.effect || '';
  $('approvalToolId').textContent = descriptor.toolId + (descriptor.serverId ? ` · ${descriptor.serverId}` : ` · ${descriptor.source || ''}`);
  $('approvalPreview').textContent = descriptor.previewText || descriptor.description || 'No preview available.';
  try {
    $('approvalArgs').textContent = JSON.stringify(descriptor.args || {}, null, 2);
  } catch {
    $('approvalArgs').textContent = String(descriptor.args || '');
  }
  const serverBtn = $('btnApproveServer');
  if (serverBtn) serverBtn.style.display = descriptor.serverId ? '' : 'none';
  card.classList.remove('is-hidden');
  $('btnApprove')?.focus();
  scheduleResizeToPill();
}

function hideApprovalCard() {
  pendingApproval = null;
  $('approvalCard')?.classList.add('is-hidden');
  scheduleResizeToPill();
}

function resolveApproval(decision) {
  if (!pendingApproval) return;
  const callId = pendingApproval.callId;
  hideApprovalCard();
  void window.glass.approveToolCall({ callId, decision });
}

function handleToolEvent(payload) {
  if (!payload) return;
  switch (payload.phase) {
    case 'thinking':
      setReply('Thinking…');
      break;
    case 'calling':
      setReply(`Calling ${shortToolName(payload.toolId)}…`);
      break;
    case 'awaiting_approval':
      // The approval card is shown via the separate onRequestApproval channel; here we
      // just update the chip so the user sees what's going on.
      setReply(`Awaiting approval: ${shortToolName(payload.toolId)}`);
      break;
    case 'result':
      if (payload.status === 'ok') setReply(`✓ ${shortToolName(payload.toolId)}`);
      else if (payload.status === 'denied') setReply(`Denied: ${shortToolName(payload.toolId)}`);
      else setReply(`✗ ${shortToolName(payload.toolId)}${payload.error ? `: ${payload.error}` : ''}`);
      break;
    case 'final':
      // Final text is delivered via runAgent's return value; the chip clears.
      setReply('');
      break;
    default:
      break;
  }
}

function setStatus(state) {
  const has = state.hasSessionImage;
  const armed = state.captureArmed;
  $('statusDot').classList.toggle('on', armed || has);
  $('statusText').textContent = has ? (armed ? 'Clip · armed' : 'Clip ready') : armed ? 'Armed' : 'Idle';
}

function openSettings() {
  $('settingsPanel')?.classList.remove('is-hidden');
  // Lazy-load the catalogs the first time settings opens (and refresh if cache is stale).
  void loadModels(false);
  void loadTools();
  void loadAuditLog();
  void loadMcpServers();
  void loadAcpStatus();
  void (async () => {
    const k = await window.glass.getElevenLabsKeyPresent();
    if (k.present) loadVoices(false);
  })();
  scheduleResizeToPill();
}

function closeSettings() {
  $('settingsPanel')?.classList.add('is-hidden');
  scheduleResizeToPill();
}

function forcePillUi() {
  $('settingsPanel')?.classList.add('is-hidden');
  scheduleResizeToPill();
}

function applyScreenAwareReplyCap() {
  // Use screen.availHeight (excludes menu bar/dock) so the panel can fill comfortably without
  // being driven by the window's own viewport (which is what 60vh resolves against).
  const availH = (window.screen && window.screen.availHeight) || 900;
  const cap = Math.max(360, Math.floor(availH - 180)); // leave room for pill + menubar + breathing
  document.documentElement.style.setProperty('--reply-max-h', `${cap}px`);
}

function applyPillOpacity(alpha) {
  const a = Math.min(1, Math.max(0, Number(alpha) || 0));
  document.documentElement.style.setProperty('--surface-alpha', String(a));
  const slider = $('pillOpacity');
  const label = $('pillOpacityValue');
  const pct = Math.round(a * 100);
  if (slider && slider.value !== String(pct)) slider.value = String(pct);
  if (label) label.textContent = `${pct}%`;
}

let modelCatalog = [];
let modelFilter = 'all';
let currentModelId = '';

let voiceCatalog = [];
let voiceFilter = 'all';
let currentVoiceId = '';
let ttsAutoSpeak = false;

let micRecorder = null;
let micStream = null;
let micChunks = [];
let micMime = 'audio/webm;codecs=opus';

let currentTtsAudio = null;

let pendingApproval = null;  // descriptor of the call currently shown in the approval card
let activeProvider = 'openrouter';
let anthropicModel = '';

function formatPricePerMillion(perToken) {
  if (!perToken || perToken === 0) return 'free';
  const perMil = Number(perToken) * 1_000_000;
  if (perMil < 0.01) return `$${perMil.toFixed(4)}/M`;
  if (perMil < 1) return `$${perMil.toFixed(3)}/M`;
  return `$${perMil.toFixed(2)}/M`;
}

function formatContext(n) {
  if (!n) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}K ctx`;
  return `${n} ctx`;
}

function modelMatchesFilter(m, filter) {
  if (filter === 'free') return m.free;
  if (filter === 'vision') return m.vision;
  if (filter === 'audio') return m.audio || m.outputsAudio;
  return true;
}

function escapeHtml(s) {
  return String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function rebuildModelList() {
  const list = $('modelList');
  const search = $('modelSearch');
  if (!list) return;
  const q = (search?.value || '').toLowerCase().trim();
  const filtered = modelCatalog.filter((m) => {
    if (!modelMatchesFilter(m, modelFilter)) return false;
    if (!q) return true;
    return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
  });
  // Sort: vision first (most relevant for screenshots), then free, then alpha.
  filtered.sort((a, b) => {
    if (a.vision !== b.vision) return a.vision ? -1 : 1;
    if (a.free !== b.free) return a.free ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  if (!filtered.length) {
    list.innerHTML = '<li class="model-empty">No models match the filter or search.</li>';
    return;
  }
  list.innerHTML = filtered.slice(0, 200).map((m) => {
    const tags = [];
    if (m.free) tags.push('<span class="badge free">FREE</span>');
    else tags.push(`<span class="badge paid">${formatPricePerMillion(m.pricing.prompt)} in</span>`);
    if (m.vision) tags.push('<span class="badge vision">VISION</span>');
    if (m.audio) tags.push('<span class="badge audio">AUDIO</span>');
    const ctx = formatContext(m.contextLength);
    if (ctx) tags.push(`<span class="badge">${ctx}</span>`);
    const sel = m.id === currentModelId ? ' is-selected' : '';
    return `<li class="model-row${sel}" data-id="${escapeHtml(m.id)}" role="option" aria-selected="${m.id === currentModelId}">
      <div class="model-row-name">${escapeHtml(m.name)}</div>
      <div class="model-row-id">${escapeHtml(m.id)}</div>
      <div class="model-row-tags">${tags.join('')}</div>
    </li>`;
  }).join('');
}

function renderModelMeta(id) {
  const meta = $('modelMeta');
  if (!meta) return;
  if (!id) {
    meta.textContent = 'Pick a model from the list below. Filters narrow it down.';
    return;
  }
  const m = modelCatalog.find((x) => x.id === id);
  if (!m) {
    meta.innerHTML = `<div class="meta-desc">Selected: <code>${escapeHtml(id)}</code> — will be sent to OpenRouter as-is (not in fetched catalog).</div>`;
    return;
  }
  const badges = [];
  if (m.free) badges.push('<span class="badge free">FREE</span>');
  else badges.push(`<span class="badge paid">${formatPricePerMillion(m.pricing.prompt)} in · ${formatPricePerMillion(m.pricing.completion)} out</span>`);
  if (m.vision) badges.push('<span class="badge vision">VISION</span>');
  if (m.audio) badges.push('<span class="badge audio">AUDIO IN</span>');
  if (m.outputsAudio) badges.push('<span class="badge audio">AUDIO OUT</span>');
  const ctx = formatContext(m.contextLength);
  if (ctx) badges.push(`<span class="badge">${ctx}</span>`);
  meta.innerHTML = `
    <div class="meta-row"><strong>${escapeHtml(m.name)}</strong> &nbsp;<span style="font-size:10px;opacity:.55;font-family:ui-monospace,monospace;">${escapeHtml(m.id)}</span></div>
    <div class="meta-row">${badges.join('')}</div>
    ${m.description ? `<div class="meta-desc">${escapeHtml(m.description)}</div>` : ''}
  `;
}

// ——— ElevenLabs: voice catalog ———

function voiceMatchesFilter(v, filter) {
  if (filter === 'premade') return v.category === 'premade';
  if (filter === 'cloned') return v.category === 'cloned';
  if (filter === 'professional') return v.category === 'professional' || v.category === 'generated';
  return true;
}

function rebuildVoiceList() {
  const list = $('voiceList');
  const search = $('voiceSearch');
  if (!list) return;
  if (!voiceCatalog.length) {
    list.innerHTML = '';
    return;
  }
  const q = (search?.value || '').toLowerCase().trim();
  const filtered = voiceCatalog.filter((v) => {
    if (!voiceMatchesFilter(v, voiceFilter)) return false;
    if (!q) return true;
    if (v.name.toLowerCase().includes(q)) return true;
    const labelText = Object.values(v.labels || {}).join(' ').toLowerCase();
    if (labelText.includes(q)) return true;
    return false;
  });
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  if (!filtered.length) {
    list.innerHTML = '<li class="model-empty">No voices match the filter or search.</li>';
    return;
  }
  list.innerHTML = filtered.slice(0, 200).map((v) => {
    const labelKeys = ['gender', 'accent', 'age', 'use_case', 'descriptive'];
    const tags = labelKeys
      .map((k) => v.labels?.[k])
      .filter(Boolean)
      .map((t) => `<span class="badge">${escapeHtml(String(t))}</span>`);
    if (v.category) tags.unshift(`<span class="badge">${escapeHtml(v.category)}</span>`);
    const sel = v.voice_id === currentVoiceId ? ' is-selected' : '';
    return `<li class="model-row${sel}" data-vid="${escapeHtml(v.voice_id)}" role="option" aria-selected="${v.voice_id === currentVoiceId}">
      <div class="model-row-name">${escapeHtml(v.name)}</div>
      <div class="model-row-id">${escapeHtml(v.voice_id)}</div>
      <div class="model-row-tags">${tags.join('')}</div>
    </li>`;
  }).join('');
}

function renderVoiceMeta(id) {
  const meta = $('voiceMeta');
  if (!meta) return;
  if (!voiceCatalog.length) {
    meta.textContent = 'Add an ElevenLabs key, then click ↻ Refresh to load voices.';
    return;
  }
  if (!id) {
    meta.textContent = 'Pick a voice from the list above.';
    return;
  }
  const v = voiceCatalog.find((x) => x.voice_id === id);
  if (!v) {
    meta.innerHTML = `<div class="meta-desc">Selected: <code>${escapeHtml(id)}</code> (not in fetched catalog).</div>`;
    return;
  }
  const labels = Object.entries(v.labels || {})
    .map(([k, val]) => `<span class="badge">${escapeHtml(k)}: ${escapeHtml(String(val))}</span>`)
    .join('');
  meta.innerHTML = `
    <div class="meta-row"><strong>${escapeHtml(v.name)}</strong> &nbsp;<span style="font-size:10px;opacity:.55;font-family:ui-monospace,monospace;">${escapeHtml(v.voice_id)}</span></div>
    ${labels ? `<div class="meta-row">${labels}</div>` : ''}
    ${v.description ? `<div class="meta-desc">${escapeHtml(v.description)}</div>` : ''}
  `;
}

async function loadVoices(force) {
  const meta = $('voiceMeta');
  if (meta) meta.textContent = 'Loading voices from ElevenLabs…';
  const r = await window.glass.listVoices(force);
  if (!r.ok) {
    voiceCatalog = [];
    rebuildVoiceList();
    if (meta) meta.textContent = r.error || 'Could not load voices.';
    return;
  }
  voiceCatalog = r.voices || [];
  rebuildVoiceList();
  renderVoiceMeta(currentVoiceId);
}

// ——— ElevenLabs: TTS playback ———

function stopTts() {
  if (currentTtsAudio) {
    try { currentTtsAudio.pause(); } catch {}
    currentTtsAudio.src = '';
    currentTtsAudio = null;
  }
  updateSpeakBtn(false);
}

function updateSpeakBtn(speaking) {
  const btn = $('btnReplySpeak');
  if (!btn) return;
  btn.textContent = speaking ? '⏹ Stop' : '🔊 Speak';
  btn.classList.toggle('is-on', speaking);
}

async function speakAnswer(text) {
  stopTts();
  if (!text || !text.trim()) return;
  const r = await window.glass.speakText({ text });
  if (!r.ok) {
    setReply(r.error || 'TTS failed');
    return;
  }
  const audio = new Audio(`data:${r.mimeType || 'audio/mpeg'};base64,${r.base64}`);
  currentTtsAudio = audio;
  audio.onended = () => updateSpeakBtn(false);
  audio.onerror = () => updateSpeakBtn(false);
  updateSpeakBtn(true);
  try { await audio.play(); } catch (e) {
    updateSpeakBtn(false);
    setReply(`Playback failed: ${e.message || e}`);
  }
}

// ——— ElevenLabs: STT (mic recording) ———

function updateMicBtn(recording) {
  const btn = $('btnMic');
  if (!btn) return;
  btn.classList.toggle('is-recording', recording);
  const label = btn.querySelector('.mic-label');
  if (label) label.textContent = recording ? 'Stop' : 'Mic';
  btn.title = recording ? 'Stop recording and transcribe' : 'Record voice → transcribes into the prompt';
}

async function startMicRecording() {
  if (micRecorder) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setReply('Microphone not available in this environment.');
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    setReply('Mic access denied. Allow in System Settings → Privacy & Security → Microphone, then restart.');
    return;
  }
  micChunks = [];
  micMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm');
  micRecorder = new MediaRecorder(micStream, { mimeType: micMime });
  micRecorder.ondataavailable = (e) => { if (e.data?.size) micChunks.push(e.data); };
  micRecorder.onstop = onMicStopped;
  micRecorder.start();
  updateMicBtn(true);
  setReply('Recording… click Stop or hit Mic again.');
}

async function onMicStopped() {
  const stream = micStream;
  micStream = null;
  micRecorder = null;
  updateMicBtn(false);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  const chunks = micChunks;
  micChunks = [];
  if (!chunks.length) {
    setReply('No audio captured.');
    return;
  }
  setReply('Transcribing…');
  const blob = new Blob(chunks, { type: micMime });
  const buf = await blob.arrayBuffer();
  const r = await window.glass.transcribeAudio({ audioBuffer: buf, mimeType: micMime });
  if (!r.ok) {
    setReply(r.error || 'Transcription failed');
    return;
  }
  const promptEl = $('prompt');
  if (promptEl) {
    const existing = (promptEl.value || '').trim();
    promptEl.value = existing ? `${existing} ${r.text}` : r.text;
    promptEl.focus();
    promptEl.selectionStart = promptEl.selectionEnd = promptEl.value.length;
    syncPromptSize();
  }
  setReply('Transcribed.');
}

function stopMicRecording() {
  if (!micRecorder) return;
  try { micRecorder.stop(); } catch {}
}

// ——— Agent settings: tools + audit log ———

async function loadTools() {
  const list = $('toolList');
  if (!list) return;
  const r = await window.glass.listTools();
  if (!r?.ok || !r.tools?.length) {
    list.innerHTML = '<li class="model-empty">No tools registered yet.</li>';
    return;
  }
  list.innerHTML = r.tools.map((t) => {
    const policy = t.policy || '';
    const opts = (val, label) =>
      `<option value="${val}" ${policy === val ? 'selected' : ''}>${label}</option>`;
    return `<li class="tool-row" data-id="${escapeHtml(t.id)}">
      <span class="tool-id">${escapeHtml(t.id)}</span>
      <span class="tool-effect" data-effect="${escapeHtml(t.effect)}">${escapeHtml(t.effect)}</span>
      <select class="tool-policy" data-id="${escapeHtml(t.id)}">
        <option value="" ${!policy ? 'selected' : ''}>default</option>
        ${opts('auto', 'auto')}
        ${opts('prompt', 'prompt')}
        ${opts('always-prompt', 'always')}
      </select>
    </li>`;
  }).join('');
}

// ——— Agent Control Plane (Astra MCP server) ———

function renderAcpSnippets(port, token) {
  const url = `http://127.0.0.1:${port}/`;
  const t = token || '<paste-token-here>';
  $('acpSnippetClaude').textContent = JSON.stringify({
    mcpServers: {
      'astra-dock': {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${t}` },
      },
    },
  }, null, 2);
  $('acpSnippetCodex').textContent =
    `[mcp_servers.astra-dock]\n` +
    `url = "${url}"\n` +
    `bearer_token_env = "ASTRA_DOCK_TOKEN"\n` +
    `# then: export ASTRA_DOCK_TOKEN="${t}"\n`;
  $('acpSnippetGeneric').textContent =
    `URL:        ${url}\n` +
    `Header:     Authorization: Bearer ${t}\n` +
    `Transport:  Streamable HTTP (MCP 2025-06-18)\n` +
    `Binding:    127.0.0.1 only — never expose beyond loopback`;
}

function renderAcpToolList(tools) {
  const host = $('acpToolList');
  if (!host) return;
  host.innerHTML = tools.map((t) => `
    <div class="acp-tool-row">
      <span class="acp-tool-name">${escapeHtml(t.name)}</span>
      <span class="tool-effect" data-effect="${escapeHtml(t.effect)}">${escapeHtml(t.effect)}</span>
      <label class="acp-toggle"><input type="checkbox" class="pill-toggle acp-tool-toggle" data-name="${escapeHtml(t.name)}" ${t.enabled ? 'checked' : ''} /></label>
      <div class="acp-tool-desc">${escapeHtml(t.description)}</div>
    </div>
  `).join('');
}

async function loadAcpStatus() {
  const r = await window.glass.getAstraServerStatus();
  if (!r?.ok) return;
  const enabledToggle = $('acpEnabled');
  if (enabledToggle) enabledToggle.checked = Boolean(r.enabled);
  const chip = $('acpStatusChip');
  if (chip) {
    if (r.running) { chip.dataset.state = 'on'; chip.textContent = 'RUNNING'; }
    else if (r.enabled) { chip.dataset.state = 'error'; chip.textContent = 'ENABLED · NOT RUNNING'; }
    else { chip.dataset.state = 'off'; chip.textContent = 'OFF'; }
  }
  const showWhenEnabled = ['acpEndpoint', 'acpTokenRow', 'acpSnippets', 'acpToolList'];
  for (const id of showWhenEnabled) {
    const el = $(id);
    if (el) el.hidden = !r.enabled;
  }
  if (r.enabled) {
    $('acpEndpoint').textContent = `http://127.0.0.1:${r.port}/  (loopback only)`;
    renderAcpToolList(r.tools || []);
    // Snippets render with placeholder token; full token only appears after Reveal.
    renderAcpSnippets(r.port, null);
  }
}

// ——— MCP server management ———

async function loadMcpServers() {
  const host = $('mcpServers');
  if (!host) return;
  const r = await window.glass.listMcpServers();
  const servers = (r?.ok && r.servers) || [];
  if (!servers.length) {
    host.innerHTML = '<p class="model-hint">No MCP servers configured yet. Add one above to connect to Claude Code, a filesystem MCP, or any other stdio MCP server.</p>';
    return;
  }
  // Detect the common gotcha: connected servers with zero registered tools.
  const connectedNoTools = servers.filter(
    (s) => s.status === 'connected' && (s.discoveredTools || []).every((t) => !t.registered),
  );
  const banner = connectedNoTools.length
    ? `<div class="mcp-banner">⚠ ${connectedNoTools.length} connected MCP server${connectedNoTools.length > 1 ? 's have' : ' has'} no tools registered yet. The agent can't call them until you click <strong>Register all</strong> (or pick individual tools) on each server below.</div>`
    : '';
  host.innerHTML = banner + servers.map(renderMcpServerCard).join('');
}

function renderMcpServerCard(s) {
  const isHttp = s.type === 'http';
  const isConnected = s.status === 'connected';
  const isConnecting = s.status === 'connecting';
  const cardClass =
    isConnected ? 'is-connected'
    : isConnecting ? 'is-connecting'
    : s.status === 'error' ? 'is-error'
    : '';

  // Body lines differ per transport.
  let body = '';
  let warn = '';
  if (isHttp) {
    body = `<div class="mcp-server-cmd">${escapeHtml(s.config.url || '')}</div>`;
    const authLine = s.hasBearerToken
      ? `<div class="mcp-server-meta">🔒 Authorization: Bearer <code>•••••</code> · <button type="button" class="link-btn" data-mcp-action="edit-auth" data-id="${escapeHtml(s.id)}">edit</button></div>`
      : `<div class="mcp-server-meta">No auth header set · <button type="button" class="link-btn" data-mcp-action="edit-auth" data-id="${escapeHtml(s.id)}">add bearer token</button></div>`;
    body += authLine;
    // additional headers (non-Authorization) summarized
    const headerKeys = Object.keys(s.config.headers || {}).filter((k) => k.toLowerCase() !== 'authorization');
    if (headerKeys.length) {
      body += `<div class="mcp-server-meta">Headers: ${headerKeys.map(escapeHtml).join(', ')}</div>`;
    }
    if (!/^https:/i.test(s.config.url || '')) {
      warn = `<div class="mcp-server-warn">⚠ URL is not HTTPS — traffic + bearer token will travel in plaintext.</div>`;
    }
  } else {
    const cmd = `${escapeHtml(s.config.command || '')} ${escapeHtml((s.config.args || []).join(' '))}`.trim();
    body = `<div class="mcp-server-cmd">${cmd}</div>`;
    if (s.isAbsoluteCommand === false) {
      warn = `<div class="mcp-server-warn">⚠ Command is not an absolute path — packaged builds may not resolve it. Prefer the full path (e.g. /opt/homebrew/bin/npx).</div>`;
    }
  }

  const errBlock = s.lastError
    ? `<div class="mcp-server-error">${escapeHtml(s.lastError)}</div>`
    : '';
  const connectBtn = isConnected
    ? `<button type="button" class="pill-btn" data-mcp-action="disconnect" data-id="${escapeHtml(s.id)}">Disconnect</button>`
    : `<button type="button" class="pill-btn pill-btn-primary" data-mcp-action="connect" data-id="${escapeHtml(s.id)}" ${isConnecting ? 'disabled' : ''}>Connect</button>`;
  const unregistered = isConnected
    ? (s.discoveredTools || []).filter((t) => !t.registered).length
    : 0;
  const refreshBtn = isConnected
    ? `<button type="button" class="pill-btn" data-mcp-action="refresh" data-id="${escapeHtml(s.id)}">↻ Refresh tools</button>`
    : '';
  const addAllBtn = isConnected && unregistered > 0
    ? `<button type="button" class="pill-btn pill-btn-primary" data-mcp-action="add-all" data-id="${escapeHtml(s.id)}" title="Add every discovered tool from this server to the registry">＋ Register all (${unregistered})</button>`
    : '';
  const toolsBlock = isConnected ? renderMcpToolList(s) : '';
  const transportBadge = isHttp
    ? '<span class="mcp-transport-badge" data-t="http">HTTP</span>'
    : '<span class="mcp-transport-badge" data-t="stdio">stdio</span>';

  return `<div class="mcp-server-card ${cardClass}" data-id="${escapeHtml(s.id)}">
    <div class="mcp-server-head">
      <span class="mcp-server-id">${escapeHtml(s.id)}</span>
      ${transportBadge}
      <span class="mcp-server-status" data-status="${escapeHtml(s.status)}">${escapeHtml(s.status)}</span>
    </div>
    ${body}
    ${warn}
    ${errBlock}
    <div class="mcp-server-actions">
      ${connectBtn}
      ${addAllBtn}
      ${refreshBtn}
      <button type="button" class="pill-btn pill-btn-danger" data-mcp-action="remove" data-id="${escapeHtml(s.id)}">Remove</button>
    </div>
    ${toolsBlock}
  </div>`;
}

function renderMcpToolList(s) {
  const tools = s.discoveredTools || [];
  if (!tools.length) return '<p class="model-hint">No tools discovered.</p>';
  const rows = tools.map((t) => renderMcpToolRow(s.id, t)).join('');
  return `<ul class="mcp-tool-list">${rows}</ul>`;
}

function renderMcpToolRow(serverId, t) {
  const effectBadge = `<span class="tool-effect" data-effect="${escapeHtml(t.effect)}">${escapeHtml(t.effect)}</span>`;
  const action = t.registered
    ? `<button type="button" class="pill-btn" data-mcp-action="unregister" data-server="${escapeHtml(serverId)}" data-tool="${escapeHtml(t.name)}">Unregister</button>`
    : `<button type="button" class="pill-btn pill-btn-primary" data-mcp-action="register" data-server="${escapeHtml(serverId)}" data-tool="${escapeHtml(t.name)}">Add to registry</button>`;
  const warnings = (t.warnings || []).slice(0, 6).map((w) =>
    `<span class="badge" data-severity="${escapeHtml(w.severity)}" title="${escapeHtml(w.message)}">${escapeHtml(w.kind)}</span>`
  ).join('');
  const desc = t.description ? `<div class="mcp-tool-desc">${escapeHtml(t.description)}</div>` : '';
  return `<li class="mcp-tool-row">
    <div class="mcp-tool-row-head">
      <span class="mcp-tool-name">${escapeHtml(t.name)}</span>
      ${effectBadge}
      ${action}
    </div>
    ${desc}
    ${warnings ? `<div class="mcp-tool-warnings">${warnings}</div>` : ''}
  </li>`;
}

function parseRemoteMcpForm() {
  const id = ($('mcpRemoteId')?.value || '').trim();
  const url = ($('mcpRemoteUrl')?.value || '').trim();
  const bearerToken = ($('mcpRemoteBearer')?.value || '').trim();
  const headerLines = ($('mcpRemoteHeaders')?.value || '').split('\n');
  const headers = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    if (k && k.toLowerCase() !== 'authorization') headers[k] = v;
  }
  return { id, type: 'http', url, bearerToken, headers, enabled: false };
}

function parseMcpForm() {
  const id = ($('mcpAddId')?.value || '').trim();
  const command = ($('mcpAddCommand')?.value || '').trim();
  const args = ($('mcpAddArgs')?.value || '')
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const envLines = ($('mcpAddEnv')?.value || '').split('\n');
  const env = {};
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1);
    if (k) env[k] = v;
  }
  return { id, type: 'stdio', command, args, env, enabled: false };
}

async function loadAuditLog() {
  const list = $('auditList');
  if (!list) return;
  const r = await window.glass.getAuditLog(20);
  if (!r?.ok || !r.entries?.length) {
    list.innerHTML = '<li class="model-empty">No tool calls yet.</li>';
    return;
  }
  // Show newest first.
  const entries = [...r.entries].reverse();
  list.innerHTML = entries.map((e) => {
    let ts;
    try { ts = new Date(e.ts).toLocaleTimeString(); } catch { ts = '—'; }
    return `<li class="audit-row">
      <span class="audit-ts">${escapeHtml(ts)}</span>
      <span class="audit-id">${escapeHtml(e.id || '')}</span>
      <span class="audit-status" data-status="${escapeHtml(e.status || '')}">${escapeHtml(e.status || '')} · ${Math.round(e.duration_ms || 0)}ms</span>
    </li>`;
  }).join('');
}

async function loadModels(force) {
  const meta = $('modelMeta');
  if (meta) meta.textContent = 'Loading model catalog from OpenRouter…';
  const r = await window.glass.listModels(force);
  if (!r.ok) {
    if (meta) meta.textContent = `Couldn't load models: ${r.error || 'unknown error'}.`;
    return;
  }
  modelCatalog = r.models || [];
  rebuildModelList();
  renderModelMeta(currentModelId);
}

async function refreshState() {
  const s = await window.glass.getState();
  currentModelId = s.openrouterModel || '';
  currentVoiceId = s.elevenlabsVoiceId || '';
  ttsAutoSpeak = Boolean(s.ttsAutoSpeak);
  activeProvider = s.provider || 'openrouter';
  const providerSel = $('providerSelect');
  if (providerSel) providerSel.value = activeProvider;
  const anthField = $('anthropicModelField');
  if (anthField) anthField.style.display = activeProvider === 'anthropic' ? '' : 'none';
  rebuildModelList();
  renderModelMeta(currentModelId);
  rebuildVoiceList();
  renderVoiceMeta(currentVoiceId);
  const ttsToggle = $('ttsAutoSpeak');
  if (ttsToggle) ttsToggle.checked = ttsAutoSpeak;
  const k = await window.glass.getOpenRouterKeyPresent();
  if ($('apiKey')) {
    if (k.present) {
      $('apiKey').placeholder = k.looksValid
        ? `On file: ${k.prefix}… (${k.length} chars) — paste to replace`
        : `⚠ On file: ${k.prefix}… (${k.length} chars) — looks invalid; paste a fresh one`;
    } else {
      $('apiKey').placeholder = 'sk-or-v1 key from openrouter.ai';
    }
  }
  const ek = await window.glass.getElevenLabsKeyPresent();
  const ekEl = $('elevenlabsKey');
  if (ekEl) ekEl.placeholder = ek.present ? 'Key on file — enter to replace' : 'sk_… from elevenlabs.io';
  if (typeof s.pillOpacity === 'number') applyPillOpacity(s.pillOpacity);
  setStatus(s);
  scheduleResizeToPill();
}

function wireExternalLink(el) {
  if (!el) return;
  el.addEventListener('click', (e) => {
    e.preventDefault();
    const href = el.getAttribute('href');
    if (href) void window.glass.openExternal(href);
  });
}

function wire() {
  $('btnHide').addEventListener('click', () => window.glass.toggleVisibility());

  $('btnSettings').addEventListener('click', () => openSettings());
  $('btnSettingsDone').addEventListener('click', () => closeSettings());

  wireExternalLink($('linkOpenRouter'));
  wireExternalLink($('linkOpenRouterModels'));

  $('btnCapScreen').addEventListener('click', async () => {
    setReply('Capturing…');
    try {
      const r = await window.glass.capturePrimaryScreen();
      setReply(r.ok ? `Screen · ${r.meta?.name || 'ok'}` : JSON.stringify(r));
      await refreshState();
    } catch (e) {
      setReply(String(e.message || e));
    }
  });

  $('btnCapWindow').addEventListener('click', async () => {
    setReply('Capturing…');
    try {
      const r = await window.glass.captureActiveWindow();
      setReply(r.ok ? `Window · ${r.meta?.name || '?'}` : JSON.stringify(r));
      await refreshState();
    } catch (e) {
      setReply(String(e.message || e));
    }
  });

  const searchInput = $('modelSearch');
  if (searchInput) {
    searchInput.addEventListener('input', () => rebuildModelList());
  }

  const modelListEl = $('modelList');
  if (modelListEl) {
    modelListEl.addEventListener('click', async (e) => {
      const row = e.target.closest('.model-row');
      if (!row) return;
      const id = row.dataset.id;
      if (!id) return;
      currentModelId = id;
      await window.glass.setOpenRouterModel(id);
      rebuildModelList();
      renderModelMeta(id);
    });
  }

  const filterEl = $('modelFilters');
  if (filterEl) {
    filterEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      modelFilter = btn.dataset.filter || 'all';
      for (const c of filterEl.querySelectorAll('.chip')) {
        c.classList.toggle('is-active', c === btn);
      }
      rebuildModelList();
    });
  }

  const refreshBtn = $('btnRefreshModels');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refreshBtn.disabled = true;
      const original = refreshBtn.textContent;
      refreshBtn.textContent = '↻ Refreshing…';
      void loadModels(true).finally(() => {
        refreshBtn.disabled = false;
        refreshBtn.textContent = original;
      });
    });
  }

  // ——— ElevenLabs settings wiring ———

  const btnSaveEl = $('btnSaveElevenKey');
  if (btnSaveEl) {
    btnSaveEl.addEventListener('click', async () => {
      const v = $('elevenlabsKey').value.trim();
      const r = await window.glass.setElevenLabsKey(v);
      $('elevenlabsKey').value = '';
      setReply(r.saved ? 'ElevenLabs key saved.' : 'No change (enter a key to save).');
      await refreshState();
      if (r.saved) void loadVoices(true);
    });
  }

  const voiceSearch = $('voiceSearch');
  if (voiceSearch) voiceSearch.addEventListener('input', () => rebuildVoiceList());

  const voiceListEl = $('voiceList');
  if (voiceListEl) {
    voiceListEl.addEventListener('click', async (e) => {
      const row = e.target.closest('.model-row');
      if (!row) return;
      const id = row.dataset.vid;
      if (!id) return;
      currentVoiceId = id;
      await window.glass.setElevenLabsVoice(id);
      rebuildVoiceList();
      renderVoiceMeta(id);
    });
  }

  const voiceFiltersEl = $('voiceFilters');
  if (voiceFiltersEl) {
    voiceFiltersEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      voiceFilter = btn.dataset.vfilter || 'all';
      for (const c of voiceFiltersEl.querySelectorAll('.chip')) {
        c.classList.toggle('is-active', c === btn);
      }
      rebuildVoiceList();
    });
  }

  const refreshVoicesBtn = $('btnRefreshVoices');
  if (refreshVoicesBtn) {
    refreshVoicesBtn.addEventListener('click', () => {
      refreshVoicesBtn.disabled = true;
      const original = refreshVoicesBtn.textContent;
      refreshVoicesBtn.textContent = '↻ Refreshing…';
      void loadVoices(true).finally(() => {
        refreshVoicesBtn.disabled = false;
        refreshVoicesBtn.textContent = original;
      });
    });
  }

  const ttsToggle = $('ttsAutoSpeak');
  if (ttsToggle) {
    ttsToggle.addEventListener('change', async () => {
      ttsAutoSpeak = ttsToggle.checked;
      await window.glass.setTtsAutoSpeak(ttsToggle.checked);
    });
  }

  const btnMic = $('btnMic');
  if (btnMic) {
    btnMic.addEventListener('click', () => {
      if (micRecorder) stopMicRecording();
      else void startMicRecording();
    });
  }

  const btnSpeak = $('btnReplySpeak');
  if (btnSpeak) {
    btnSpeak.addEventListener('click', () => {
      if (currentTtsAudio) stopTts();
      else {
        const text = $('replyBody')?.textContent || '';
        if (text.trim()) void speakAnswer(text);
      }
    });
  }

  const linkElKeys = $('linkElevenLabsKeys');
  if (linkElKeys) wireExternalLink(linkElKeys);

  // ——— Approval card + tool-event stream ———

  $('btnApprove')?.addEventListener('click', () => resolveApproval('approve'));
  $('btnApproveServer')?.addEventListener('click', () => resolveApproval('approve_server_session'));
  $('btnDeny')?.addEventListener('click', () => resolveApproval('deny'));

  document.addEventListener('keydown', (e) => {
    if (!pendingApproval) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); resolveApproval('approve'); }
    if (meta && e.key.toLowerCase() === 'n') { e.preventDefault(); resolveApproval('deny'); }
  });

  window.glass.onToolEvent(handleToolEvent);
  window.glass.onRequestApproval(showApprovalCard);

  // ——— Provider + Anthropic + tool policies ———

  const providerSel = $('providerSelect');
  if (providerSel) {
    providerSel.addEventListener('change', async () => {
      activeProvider = providerSel.value;
      await window.glass.setProvider(activeProvider);
      const f = $('anthropicModelField');
      if (f) f.style.display = activeProvider === 'anthropic' ? '' : 'none';
    });
  }

  $('anthropicModel')?.addEventListener('change', () => {
    anthropicModel = ($('anthropicModel')?.value || '').trim();
  });

  $('btnSaveAnthropicKey')?.addEventListener('click', async () => {
    const k = ($('anthropicKey')?.value || '').trim();
    const r = await window.glass.setProviderApiKey({ providerId: 'anthropic', key: k });
    if ($('anthropicKey')) $('anthropicKey').value = '';
    setReply(r.saved ? 'Anthropic key saved.' : 'No change (enter a key to save).');
  });

  $('toolList')?.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t?.classList?.contains('tool-policy')) return;
    const id = t.dataset.id;
    const policy = t.value || null;
    await window.glass.setToolPolicy({ toolId: id, policy });
  });

  // ——— MCP server settings ———

  $('btnMcpAdd')?.addEventListener('click', async () => {
    const cfg = parseMcpForm();
    if (!cfg.id || !cfg.command) {
      setReply('Local MCP server needs an id and a command.');
      return;
    }
    const r = await window.glass.addMcpServer(cfg);
    if (!r?.ok) {
      setReply(r?.error || 'Could not add server');
      return;
    }
    $('mcpAddId').value = '';
    $('mcpAddCommand').value = '';
    $('mcpAddArgs').value = '';
    $('mcpAddEnv').value = '';
    $('mcpAddLocalForm').open = false;
    setReply(`Added local MCP server "${cfg.id}".`);
    await loadMcpServers();
    await loadTools();
  });

  $('btnMcpAddRemote')?.addEventListener('click', async () => {
    const cfg = parseRemoteMcpForm();
    if (!cfg.id || !cfg.url) {
      setReply('Remote MCP server needs an id and a URL.');
      return;
    }
    const r = await window.glass.addMcpServer(cfg);
    if (!r?.ok) {
      setReply(r?.error || 'Could not add server');
      return;
    }
    $('mcpRemoteId').value = '';
    $('mcpRemoteUrl').value = '';
    $('mcpRemoteBearer').value = '';
    $('mcpRemoteHeaders').value = '';
    setReply(`Added remote MCP server "${cfg.id}".`);
    await loadMcpServers();
    await loadTools();
  });

  $('mcpServers')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-mcp-action]');
    if (!btn) return;
    const action = btn.dataset.mcpAction;
    const id = btn.dataset.id;
    const serverId = btn.dataset.server;
    const toolName = btn.dataset.tool;
    btn.disabled = true;
    try {
      if (action === 'connect') {
        setReply(`Connecting to ${id}…`);
        const r = await window.glass.connectMcpServer(id);
        if (!r?.ok) setReply(`Connect failed: ${r?.error || 'unknown error'}`);
        else setReply(`Connected to ${id}.`);
      } else if (action === 'disconnect') {
        await window.glass.disconnectMcpServer(id);
        setReply(`Disconnected ${id}.`);
      } else if (action === 'refresh') {
        const r = await window.glass.refreshMcpTools(id);
        if (!r?.ok) setReply(`Refresh failed: ${r?.error || ''}`);
        else setReply(`Refreshed tools for ${id}.`);
      } else if (action === 'remove') {
        if (!confirm(`Remove MCP server "${id}"? Any registered tools from this server will be removed too.`)) return;
        await window.glass.removeMcpServer(id);
        setReply(`Removed ${id}.`);
      } else if (action === 'register') {
        const r = await window.glass.registerMcpTool({ serverId, toolName });
        if (!r?.ok) setReply(`Register failed: ${r?.error || ''}`);
        else setReply(r.alreadyRegistered ? `${toolName} already registered.` : `Registered ${toolName}.`);
        await loadTools();
      } else if (action === 'add-all') {
        const serverR = await window.glass.listMcpServers();
        const srv = (serverR?.servers || []).find((s) => s.id === id);
        const pending = (srv?.discoveredTools || []).filter((t) => !t.registered);
        if (!pending.length) {
          setReply('Nothing to register.');
        } else {
          setReply(`Registering ${pending.length} tool${pending.length > 1 ? 's' : ''}…`);
          let added = 0;
          for (const t of pending) {
            const rr = await window.glass.registerMcpTool({ serverId: id, toolName: t.name });
            if (rr?.ok && !rr.alreadyRegistered) added += 1;
          }
          setReply(`Registered ${added} tool${added === 1 ? '' : 's'} from ${id}.`);
          await loadTools();
        }
      } else if (action === 'unregister') {
        await window.glass.unregisterMcpTool({ serverId, toolName });
        setReply(`Unregistered ${toolName}.`);
        await loadTools();
      } else if (action === 'edit-auth') {
        const value = window.prompt(
          `Bearer token for "${id}" (leave blank to clear). Stored encrypted at rest.`,
          '',
        );
        if (value === null) return; // user cancelled
        const r = await window.glass.updateMcpServerAuth({ id, bearerToken: value });
        if (r?.ok) setReply(value ? `Updated bearer token for ${id}.` : `Cleared bearer token for ${id}.`);
        else setReply(r?.error || 'Could not update auth');
      }
      await loadMcpServers();
    } finally {
      btn.disabled = false;
    }
  });

  // Auto-refresh server list on status events so connection states stay live.
  window.glass.onMcpStatus?.(() => { void loadMcpServers(); });
  window.glass.onMcpRemoved?.(() => { void loadMcpServers(); });

  // ——— Agent Control Plane (PR-D) ———

  $('acpEnabled')?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    setReply(enabled ? 'Starting Astra MCP server…' : 'Stopping Astra MCP server…');
    const r = await window.glass.setAstraServerEnabled(enabled);
    if (!r?.ok) setReply(r?.error || 'Server toggle failed');
    else setReply(enabled ? `Astra MCP server running on 127.0.0.1:${r.port}` : 'Astra MCP server stopped.');
    await loadAcpStatus();
  });

  $('btnAcpReveal')?.addEventListener('click', async () => {
    const r = await window.glass.revealAstraServerToken();
    if (!r?.ok || !r.token) {
      setReply('No token to reveal — enable the server first.');
      return;
    }
    const display = $('acpTokenDisplay');
    if (display) {
      display.textContent = r.token;
      display.classList.add('is-revealed');
    }
    // Re-render snippets with the actual token in place.
    const status = await window.glass.getAstraServerStatus();
    if (status?.ok) renderAcpSnippets(status.port, r.token);
    setTimeout(async () => {
      if (display) {
        display.textContent = '••••••••••••••••';
        display.classList.remove('is-revealed');
      }
      // Re-render snippets back to placeholder.
      const s2 = await window.glass.getAstraServerStatus();
      if (s2?.ok) renderAcpSnippets(s2.port, null);
    }, 30_000);
  });

  $('btnAcpCopy')?.addEventListener('click', async () => {
    const r = await window.glass.revealAstraServerToken();
    if (!r?.ok || !r.token) {
      setReply('No token to copy — enable the server first.');
      return;
    }
    try {
      await navigator.clipboard.writeText(r.token);
      setReply('Token copied to clipboard (clear it from the clipboard when you\'re done).');
    } catch (e) {
      setReply('Copy failed: ' + (e?.message || e));
    }
  });

  $('btnAcpRotate')?.addEventListener('click', async () => {
    if (!window.confirm('Rotate the Astra MCP server bearer token? Any agents using the current token must be updated with the new one.')) return;
    setReply('Rotating token…');
    await window.glass.rotateAstraServerToken();
    setReply('Rotated. Reveal + Copy to get the new value.');
    await loadAcpStatus();
  });

  $('acpToolList')?.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t?.classList?.contains('acp-tool-toggle')) return;
    await window.glass.setAstraServerToolEnabled({ name: t.dataset.name, enabled: t.checked });
  });

  // External agents calling astra_show_overlay_message land here.
  window.glass.onOverlayMessage?.((payload) => {
    if (payload?.text) setReply(payload.text);
  });

  const opacitySlider = $('pillOpacity');
  if (opacitySlider) {
    // Live preview as the user drags; persist on release to avoid spamming IPC.
    opacitySlider.addEventListener('input', () => {
      applyPillOpacity(Number(opacitySlider.value) / 100);
    });
    opacitySlider.addEventListener('change', () => {
      void window.glass.setPillOpacity(Number(opacitySlider.value) / 100);
    });
  }

  $('btnSaveKey').addEventListener('click', async () => {
    const key = $('apiKey').value.trim();
    const r = await window.glass.setOpenRouterKey(key);
    $('apiKey').value = '';
    if (!r.saved) {
      setReply('No change (enter a key to save).');
    } else {
      let msg = `Saved ${r.prefix}… (${r.sanitizedLength} chars)`;
      if (r.stripped > 0) msg += ` — stripped ${r.stripped} non-ASCII char${r.stripped > 1 ? 's' : ''}`;
      setReply(msg);
      if (!r.looksValid) {
        showAnswer(
          `Saved your key as: ${r.prefix}… (${r.sanitizedLength} chars)\n\n` +
          `⚠ This doesn't look like a valid OpenRouter key (expected sk-or-v1-... followed by ~60 lowercase-hex chars). Common cause: macOS auto-substituted three dots into an ellipsis when you pasted a previewed/truncated key.\n\n` +
          `Fix: open https://openrouter.ai/settings/keys, copy the FULL key (it'll be ~73 chars), and paste using ⌥⌘V (paste-without-formatting) to bypass smart-quote substitution.`
        );
      }
    }
    await refreshState();
  });

  $('btnClearKey')?.addEventListener('click', async () => {
    if (!window.confirm('Clear the saved OpenRouter key?')) return;
    await window.glass.clearProviderKey('openrouter');
    setReply('OpenRouter key cleared.');
    await refreshState();
  });

  $('btnAsk').addEventListener('click', async () => {
    const prompt = $('prompt').value.trim();
    if (!prompt) {
      setReply('Enter a prompt.');
      return;
    }
    clearAnswer();
    // Ask "just works": if no capture in the buffer, grab the active window now.
    // The agent loop can also call capture tools mid-run, but pre-capturing keeps
    // simple one-shot questions fast.
    const state = await window.glass.getState();
    if (!state.hasSessionImage) {
      setReply('Capturing window…');
      try {
        const r = await window.glass.captureActiveWindow();
        if (r?.meta?.name) setReply(`Window · ${r.meta.name}`);
      } catch (e) {
        setReply(String(e.message || e));
        return;
      }
      await refreshState();
    }
    setReply('Thinking…');
    const payload = { prompt, providerId: activeProvider, includeScreen: true };
    if (activeProvider === 'anthropic') {
      const m = ($('anthropicModel')?.value || anthropicModel || '').trim();
      if (!m) {
        setReply('Set an Anthropic model id in settings first.');
        return;
      }
      payload.model = m;
      anthropicModel = m;
    }
    const r = await window.glass.runAgent(payload);
    if (r.ok) {
      setReply('');
      showAnswer(r.text);
      // The agent may have run tools; refresh the audit log for the settings panel.
      void loadAuditLog();
    } else {
      const errText = String(r.error || 'Unknown error');
      // Short summary in the chip, full text in the panel so users can read it all.
      const short = errText.length > 60 ? `${errText.slice(0, 57)}…` : errText;
      setReply(short);
      let detail = errText;
      if (/\b429\b/.test(errText)) {
        detail += '\n\nTip: this is a rate limit on the upstream provider. Either wait ~60 seconds, switch to a paid model (anthropic/claude-3-5-sonnet, openai/gpt-4o-mini, etc.) in ⚙ Settings, or pick a different free model.';
      } else if (/\b401\b/.test(errText)) {
        detail += '\n\nTip: your API key was rejected. Re-paste it in ⚙ Settings.';
      } else if (/\b404\b/.test(errText)) {
        detail += '\n\nTip: the model id may be wrong. Click ↻ Refresh in the Model picker and pick a fresh one.';
      }
      showAnswer(detail);
    }
  });

  $('btnPanic').addEventListener('click', async () => {
    await window.glass.panic();
    setReply('Panic · buffer cleared');
    clearAnswer();
    await refreshState();
  });

  const replyCloseBtn = $('btnReplyClose');
  if (replyCloseBtn) replyCloseBtn.addEventListener('click', () => clearAnswer());

  const replyCopyBtn = $('btnReplyCopy');
  if (replyCopyBtn) {
    replyCopyBtn.addEventListener('click', async () => {
      const text = $('replyBody')?.textContent || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const original = replyCopyBtn.textContent;
        replyCopyBtn.textContent = 'Copied';
        setTimeout(() => { replyCopyBtn.textContent = original; }, 1100);
      } catch {
        setReply('Copy failed');
      }
    });
  }

  const promptEl = $('prompt');
  if (promptEl) {
    promptEl.addEventListener('input', () => syncPromptSize());
    promptEl.addEventListener('focus', () => syncPromptSize());
    promptEl.addEventListener('blur', () => {
      requestAnimationFrame(() => syncPromptSize());
    });
    // Cmd/Ctrl+Enter from the prompt triggers Ask (in addition to the button).
    promptEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        $('btnAsk').click();
      }
    });
  }

  const shellEl = document.querySelector('.pill-shell');
  if (shellEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => scheduleResizeToPill()).observe(shellEl);
  }
  window.addEventListener('resize', () => scheduleResizeToPill());

  window.glass.onState((state) => setStatus(state));
  window.glass.onHotkeyAsk(() => {
    $('btnAsk').click();
  });
  window.glass.onPanicEvent(() => {
    setReply('Panic · buffer cleared');
    clearAnswer();
    refreshState();
  });
  window.glass.onForcePill(() => {
    forcePillUi();
  });
}

wire();
applyScreenAwareReplyCap();
window.addEventListener('resize', applyScreenAwareReplyCap);
refreshState();
setReply('');
syncPromptSize();
