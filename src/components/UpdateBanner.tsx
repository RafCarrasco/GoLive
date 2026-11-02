import { useEffect, useState } from 'react';
import { Download, RotateCw, X } from 'lucide-react';
import { desktop } from '../desktop';
import { siteUpdateAvailable } from '../lib/version';
import { useEmulators } from '../firebase';

const CHECK_EVERY = 5 * 60 * 1000;

// Aviso de versão nova: do app (o próprio app baixa e avisa) ou do site (comparando o bundle
// publicado). A pessoa decide quando atualizar, porque recarregar derruba a live por instantes.
export function UpdateBanner({ live }: { live: boolean }) {
  const [appVersion, setAppVersion] = useState('');
  const [site, setSite] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Só com emuladores: ?fakeUpdate=app ou ?fakeUpdate=site mostra o aviso para conferir o visual.
    const fake = useEmulators ? new URLSearchParams(location.search).get('fakeUpdate') : null;
    if (fake === 'app') setAppVersion('9.9.9');
    if (fake === 'site') setSite(true);
    if (!desktop?.watchUpdate) return;
    void desktop.watchUpdate((info) => setAppVersion(info.version)).then((r) => {
      if (r.ok && r.value) setAppVersion(r.value.version);
    });
  }, []);

  useEffect(() => {
    let stopped = false;
    const check = () =>
      void siteUpdateAvailable()
        .then((available) => !stopped && available && setSite(true))
        .catch(() => {});
    const timer = setInterval(check, CHECK_EVERY);
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (dismissed || (!appVersion && !site)) return null;
  const isApp = Boolean(appVersion);
  return (
    <div className="update-card" role="status">
      <img src="/nimbo-mascot.svg" alt="" />
      <div className="update-text">
        <strong>{isApp ? `Nimbo ${appVersion} está pronto` : 'Nova versão do Nimbo'}</strong>
        <span>
          {isApp ? 'Reinicie o app para usar.' : 'Atualize para ter as novidades.'}
          {live && ' Sua live cai por alguns segundos.'}
        </span>
        <div className="update-actions">
          <button
            className="button primary small"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              if (isApp) void desktop?.installUpdate?.();
              else location.reload();
            }}
          >
            {isApp ? <Download size={15} /> : <RotateCw size={15} />}
            {isApp ? 'Reiniciar agora' : 'Atualizar'}
          </button>
          <button className="button ghost small" onClick={() => setDismissed(true)}>
            Depois
          </button>
        </div>
      </div>
      <button className="icon-button tiny" aria-label="Fechar aviso" onClick={() => setDismissed(true)}>
        <X size={14} />
      </button>
    </div>
  );
}
