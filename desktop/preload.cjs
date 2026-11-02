// Expõe ao Nimbo (só na janela principal) as funções do app. Ver src/desktop.ts.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nimboDesktop', {
  version: 1,
  signIn: () => ipcRenderer.invoke('nimbo:signIn'),
  cancelSignIn: () => ipcRenderer.invoke('nimbo:signIn:cancel'),
  setCaptureAudio: (wanted) => ipcRenderer.invoke('nimbo:capture:audio', Boolean(wanted)),
  startAudio: () => ipcRenderer.invoke('nimbo:audio:start'),
  stopAudio: (id) => ipcRenderer.invoke('nimbo:audio:stop', String(id)),
  onAudio: (id, onData, onEnd) => {
    const data = (_event, sessionId, chunk) => {
      if (sessionId === id) onData(chunk);
    };
    const end = (_event, sessionId, error) => {
      if (sessionId !== id) return;
      cleanup();
      onEnd(error || '');
    };
    const cleanup = () => {
      ipcRenderer.off('nimbo:audio:data', data);
      ipcRenderer.off('nimbo:audio:end', end);
    };
    ipcRenderer.on('nimbo:audio:data', data);
    ipcRenderer.on('nimbo:audio:end', end);
    return cleanup;
  },
});
