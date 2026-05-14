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
