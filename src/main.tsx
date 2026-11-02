import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DesktopLoginScreen } from './components/AuthScreens';
import { APP_VERSION } from './lib/version';
import { ToastProvider } from './ui/Toast';
import { DialogProvider } from './ui/Modal';
import './style.css';

// No app, a barra de título da janela mostra a versão instalada.
if (APP_VERSION) document.title = `Nimbo ${APP_VERSION}`;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <DialogProvider>
        {location.pathname === '/desktop-login' ? <DesktopLoginScreen /> : <App />}
      </DialogProvider>
    </ToastProvider>
  </React.StrictMode>,
);
