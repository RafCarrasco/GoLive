import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DesktopLoginScreen } from './components/AuthScreens';
import { ToastProvider } from './ui/Toast';
import { DialogProvider } from './ui/Modal';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <DialogProvider>
        {location.pathname === '/desktop-login' ? <DesktopLoginScreen /> : <App />}
      </DialogProvider>
    </ToastProvider>
  </React.StrictMode>,
);
