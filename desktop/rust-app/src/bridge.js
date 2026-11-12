// Ponte do app em Rust com o site: mesmo nome e mesmos métodos de desktop/preload.cjs, para o
// src/desktop.ts funcionar sem mudança. O Rust troca o marcador de origem antes de injetar.
(() => {
  'use strict';
  // O WebView2 roda este script em todo frame; a ponte só existe na página principal do Nimbo.
  // Esconder aqui é conveniência: quem barra de verdade é o Rust (ver bridge.rs).
  if (window.top !== window.self || location.origin !== __NIMBO_APP_ORIGIN__) return;

  // Procura o invoke só na hora da chamada: não depende da ordem dos scripts de inicialização.
  const invoke = (command) => window.__TAURI_INTERNALS__.invoke(command);
  const unavailable = () => Promise.resolve({ ok: false, error: 'Ainda não disponível no app em Rust.' });
  // Registro de ouvinte que nunca dispara: devolve o "cancelar" que o site espera receber.
  const neverFires = () => () => {};

  const bridge = {
    version: 1,
    engine: 'rust',
    signIn: () => invoke('sign_in'),
    cancelSignIn: () => invoke('cancel_sign_in'),
    setCaptureAudio: unavailable,
    startAudio: unavailable,
    stopAudio: unavailable,
    watchUpdate: unavailable,
    installUpdate: unavailable,
    onUpdateProgress: neverFires,
    startGameWatch: unavailable,
    stopGameWatch: unavailable,
    onGameState: neverFires,
    onGameEnded: neverFires,
    onAudio: neverFires,
  };

  // Congelada e fixa como a do contextBridge do Electron: a página usa, não troca.
  Object.defineProperty(window, 'nimboDesktop', {
    value: Object.freeze(bridge),
    enumerable: true,
    writable: false,
    configurable: false,
  });
})();
