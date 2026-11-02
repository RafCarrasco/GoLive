import { useState } from 'react';
import { Clock, LoaderCircle } from 'lucide-react';
import { googleCredentialForDesktop, signInGoogle, signOutAccount } from '../session';
import { desktop } from '../desktop';
import { errorMessage } from '../lib/errors';
import { NicknameForm } from './Modals';

function Gate({ children }: { children: React.ReactNode }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <img className="gate-mascot" src="/nimbo-icon-256.png" alt="Nimbo" />
        {children}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

export function LoadingScreen() {
  return (
    <Gate>
      <LoaderCircle className="spin muted" size={28} />
    </Gate>
  );
}

export function LoginScreen({ error }: { error: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <Gate>
      <h1 className="wordmark">
        Nim<em>bo</em>
      </h1>
      <p className="muted">Suas lives. Sua comunidade.</p>
      <button
        className="google-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage('');
          void signInGoogle()
            .catch((e) => setMessage(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        <GoogleIcon />
        {busy ? 'Abrindo o Google…' : 'Continuar com Google'}
      </button>
      {busy && desktop && (
        <small className="muted">
          Termine o login no navegador que abriu.{' '}
          <button className="link-button" onClick={() => void desktop?.cancelSignIn()}>
            Cancelar
          </button>
        </small>
      )}
      <small className="muted">O acesso depende da aprovação de um administrador.</small>
      {(message || error) && <p className="field-error">{message || error}</p>}
    </Gate>
  );
}

export function PendingScreen({ email }: { email: string }) {
  return (
    <Gate>
      <h1>Quase lá</h1>
      <div className="pending">
        <Clock size={20} />
        <div>
          <strong>Aguardando aprovação</strong>
          <span className="muted">
            Sua solicitação foi enviada. Esta tela atualiza sozinha quando um administrador liberar o acesso.
          </span>
        </div>
      </div>
      <small className="muted">{email}</small>
      <button className="button ghost" onClick={() => void signOutAccount()}>
        Usar outra conta
      </button>
    </Gate>
  );
}

export function NicknameScreen({ onSave }: { onSave: (name: string) => Promise<void> }) {
  return (
    <Gate>
      <h1>Seu nome no Nimbo</h1>
      <p className="muted">Escolha um nickname para aparecer nos canais e nas transmissões.</p>
      <NicknameForm initial="" submitLabel="Continuar" onSubmit={onSave} />
    </Gate>
  );
}

// Aberta no navegador do sistema pelo app (o Google bloqueia login dentro do app). Entrega a
// credencial só ao app que abriu este link: porta local e código de uso único vêm do próprio app.
export function DesktopLoginScreen() {
  const params = new URLSearchParams(location.search);
  const port = Number(params.get('port'));
  const state = params.get('state') || '';
  const valid = Number.isInteger(port) && port >= 1024 && port <= 65535 && /^[0-9a-f]{48}$/.test(state);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (!valid)
    return (
      <Gate>
        <h1>Link inválido</h1>
        <p className="muted">Use o botão de login do app Nimbo para abrir esta página.</p>
      </Gate>
    );
  const deliver = (fields: Record<string, string>) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `http://127.0.0.1:${port}/callback`;
    for (const [name, value] of Object.entries({ state, ...fields })) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  };
  return (
    <Gate>
      <h1 className="wordmark">
        Nim<em>bo</em>
      </h1>
      <p className="muted">Entre com o Google para continuar no app Nimbo.</p>
      <button
        className="google-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage('');
          googleCredentialForDesktop()
            .then(deliver)
            .catch((e) => {
              setMessage(errorMessage(e));
              setBusy(false);
            });
        }}
      >
        <GoogleIcon />
        {busy ? 'Entrando…' : 'Continuar com Google'}
      </button>
      {message && <p className="field-error">{message}</p>}
    </Gate>
  );
}
