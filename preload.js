const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  setDirty: (v) => ipcRenderer.invoke('doc:setDirty', v),
  newDoc: () => ipcRenderer.invoke('doc:new'),
  openDoc: (p) => ipcRenderer.invoke('doc:open', p),
  saveDoc: (content, saveAs) => ipcRenderer.invoke('doc:save', content, saveAs),
  confirmDiscard: () => ipcRenderer.invoke('doc:confirmDiscard'),
  rebuildMenu: () => ipcRenderer.invoke('menu:rebuild'),
  forceClose: () => ipcRenderer.invoke('app:forceClose'),

  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  onMenu: (cb) => ipcRenderer.on('menu', (_e, action, payload) => cb(action, payload)),
  onRequestClose: (cb) => ipcRenderer.on('request-close', () => cb()),
  onLang: (cb) => ipcRenderer.on('lang', (_e, lang, strings) => cb(lang, strings)),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, text) => cb(text)),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
});
