// Ponte do app em Rust com o site: mesmo nome e mesmos métodos de desktop/preload.cjs, para o
// src/desktop.ts funcionar sem mudança. O Rust troca o marcador de origem antes de injetar.
(() => {
  'use strict';
  // O WebView2 roda este script em todo frame; a ponte só existe na página principal do Nimbo.
  // Esconder aqui é conveniência: quem barra de verdade é o Rust (ver bridge.rs).
  if (window.top !== window.self || location.origin !== __NIMBO_APP_ORIGIN__) return;

  // Procura o invoke só na hora da chamada: não depende da ordem dos scripts de inicialização.
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
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
    // Motor de mídia do app: captura, codifica uma vez e envia para todos (src/live/native.ts).
    media: Object.freeze({
      start: (source, quality) => invoke('media_start', { source, quality }),
      accept: (offer) => invoke('media_accept', { offer }),
      close: (id) => invoke('media_close', { id }),
      stop: () => invoke('media_stop'),
      // Seletor "o que compartilhar": lista, miniatura e ícone de cada item.
      sources: () => invoke('media_sources'),
      thumbnail: (id) => invoke('media_thumbnail', { id }),
      icon: (id) => invoke('media_icon', { id }),
    }),
  };

  // Congelada e fixa como a do contextBridge do Electron: a página usa, não troca.
  Object.defineProperty(window, 'nimboDesktop', {
    value: Object.freeze(bridge),
    enumerable: true,
    writable: false,
    configurable: false,
  });
})();
