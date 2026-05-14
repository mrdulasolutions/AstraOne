const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glass', {
  toggleVisibility: () => ipcRenderer.invoke('glass:toggleVisibility'),
  moveWindow: (dir) => ipcRenderer.invoke('glass:moveWindow', dir),
  capturePrimaryScreen: () => ipcRenderer.invoke('glass:capturePrimaryScreen'),
  captureActiveWindow: () => ipcRenderer.invoke('glass:captureActiveWindow'),
  askLlm: (payload) => ipcRenderer.invoke('glass:askLlm', payload),
  panic: () => ipcRenderer.invoke('glass:panic'),
  getState: () => ipcRenderer.invoke('glass:getState'),
  setOpenRouterKey: (key) => ipcRenderer.invoke('glass:setOpenRouterKey', { key }),
  getOpenRouterKeyPresent: () => ipcRenderer.invoke('glass:getOpenRouterKeyPresent'),
  setOpenRouterModel: (model) => ipcRenderer.invoke('glass:setOpenRouterModel', { model }),
  listModels: (force) => ipcRenderer.invoke('glass:listModels', { force: Boolean(force) }),
  setPillOpacity: (opacity) => ipcRenderer.invoke('glass:setPillOpacity', { opacity }),
  setElevenLabsKey: (key) => ipcRenderer.invoke('glass:setElevenLabsKey', { key }),
  getElevenLabsKeyPresent: () => ipcRenderer.invoke('glass:getElevenLabsKeyPresent'),
  setElevenLabsVoice: (voiceId) => ipcRenderer.invoke('glass:setElevenLabsVoice', { voiceId }),
  setTtsAutoSpeak: (enabled) => ipcRenderer.invoke('glass:setTtsAutoSpeak', { enabled: Boolean(enabled) }),
  listVoices: (force) => ipcRenderer.invoke('glass:listVoices', { force: Boolean(force) }),
  transcribeAudio: ({ audioBuffer, mimeType }) =>
    ipcRenderer.invoke('glass:transcribeAudio', { audioBuffer, mimeType }),
  speakText: ({ text, voiceId }) => ipcRenderer.invoke('glass:speakText', { text, voiceId }),
  // —— Agent / router surface ——
  runAgent: ({ prompt, providerId, model, includeScreen }) =>
    ipcRenderer.invoke('glass:runAgent', { prompt, providerId, model, includeScreen }),
  approveToolCall: ({ callId, decision }) =>
    ipcRenderer.invoke('glass:approveToolCall', { callId, decision }),
  cancelAgentRun: () => ipcRenderer.invoke('glass:cancelAgentRun'),
  getAuditLog: (limit) => ipcRenderer.invoke('glass:getAuditLog', { limit }),
  listTools: () => ipcRenderer.invoke('glass:listTools'),
  setToolPolicy: ({ toolId, policy }) =>
    ipcRenderer.invoke('glass:setToolPolicy', { toolId, policy }),
  setProvider: (providerId) => ipcRenderer.invoke('glass:setProvider', { providerId }),
  setProviderApiKey: ({ providerId, key }) =>
    ipcRenderer.invoke('glass:setProviderApiKey', { providerId, key }),
  getProviderKeyPresent: (providerId) =>
    ipcRenderer.invoke('glass:getProviderKeyPresent', { providerId }),
  onToolEvent: (fn) => {
    const ch = (_e, payload) => fn(payload);
    ipcRenderer.on('tool:event', ch);
    return () => ipcRenderer.removeListener('tool:event', ch);
  },
  onRequestApproval: (fn) => {
    const ch = (_e, descriptor) => fn(descriptor);
    ipcRenderer.on('glass:requestApproval', ch);
    return () => ipcRenderer.removeListener('glass:requestApproval', ch);
  },
  openExternal: (url) => ipcRenderer.invoke('glass:openExternal', { url }),
  resizeToContent: (size) => ipcRenderer.invoke('glass:resizeToContent', size),
  setLayout: (mode) => ipcRenderer.invoke('glass:setLayout', { mode }),
  onState: (fn) => {
    const ch = (_e, state) => fn(state);
    ipcRenderer.on('glass:state', ch);
    return () => ipcRenderer.removeListener('glass:state', ch);
  },
  onHotkeyAsk: (fn) => {
    const ch = () => fn();
    ipcRenderer.on('glass:hotkeyAsk', ch);
    return () => ipcRenderer.removeListener('glass:hotkeyAsk', ch);
  },
  onPanicEvent: (fn) => {
    const ch = () => fn();
    ipcRenderer.on('glass:panic', ch);
    return () => ipcRenderer.removeListener('glass:panic', ch);
  },
  onForcePill: (fn) => {
    const ch = () => fn();
    ipcRenderer.on('glass:forcePill', ch);
    return () => ipcRenderer.removeListener('glass:forcePill', ch);
  },
});
