const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capturePicker', {
  list: () => ipcRenderer.invoke('nimbo:picker:list'),
  choose: (id, audio) => ipcRenderer.invoke('nimbo:picker:choose', { id, audio }),
  cancel: () => ipcRenderer.invoke('nimbo:picker:cancel'),
  diagnostics: () => ipcRenderer.invoke('nimbo:picker:diagnostics'),
});
