import { useEffect, useState } from 'react';
import { Download, RotateCw, Sparkles, X } from 'lucide-react';
import { desktop } from '../desktop';
import { APP_VERSION, SITE_VERSION, siteUpdateAvailable } from '../lib/version';
import { CHANGELOG, newer } from '../lib/changelog';
import { useEmulators } from '../firebase';
import { Modal } from '../ui/Modal';

const CHECK_EVERY = 5 * 60 * 1000;
const SEEN_KEY = 'nimbo.seenVersion';

const readSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
};
const writeSeen = (v: string) => {
  try {
    localStorage.setItem(SEEN_KEY, v);
  } catch {
    // Sem armazenamento: as novidades podem reaparecer, sem outro efeito.
  }
};

// Versão nova do app (o próprio app baixa e avisa) ou do site (comparando o bundle publicado).
// Primeiro aparece um cartão; depois de "Depois" fica só o selo verde no topo, até atualizar.
// A pessoa decide quando, porque atualizar derruba a live por alguns segundos.
export function UpdateBanner({ live }: { live: boolean }) {
  const [appVersion, setAppVersion] = useState('');
  const [site, setSite] = useState(false);
  const [cardClosed, setCardClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  // App instalado mais velho que o site e sem atualização chegando: o portátil e os apps antigos
  // não se atualizam sozinhos, então o jeito é baixar o instalador de novo.
  const [outdated, setOutdated] = useState('');
  const [notes, setNotes] = useState(() => {
    let seen = readSeen();
    if (!seen) {
      // Quem já usava o Nimbo antes desta janela existir (0.3.3) vê as novidades desta versão;
      // quem chega agora não recebe novidades antigas.
      let returning = false;
      try {
        returning = Object.keys(localStorage).some((k) => k.startsWith('nimbo.'));
      } catch {
        // Sem armazenamento.
      }
      if (!returning) {
        writeSeen(SITE_VERSION);
        return [];
      }
      seen = '0.3.3';
    }
    return CHANGELOG.filter((r) => newer(r.version, seen) && !newer(r.version, SITE_VERSION));
  });

  useEffect(() => {
    // Só com emuladores: ?fakeUpdate=app|site|notes mostra cada aviso para conferir o visual.
    const fake = useEmulators ? new URLSearchParams(location.search).get('fakeUpdate') : null;
    if (fake === 'app') setAppVersion('9.9.9');
    if (fake === 'site') setSite(true);
    if (fake === 'notes') setNotes(CHANGELOG.slice(0, 2));
    if (fake === 'outdated') setOutdated('0.2.0');
    if (!desktop?.watchUpdate) return;
    void desktop.watchUpdate((info) => setAppVersion(info.version)).then((r) => {
      if (r.ok && r.value) setAppVersion(r.value.version);
    });
  }, []);

  useEffect(() => {
    const inApp = /Electron/i.test(navigator.userAgent);
    if (!inApp || (APP_VERSION && !newer(SITE_VERSION, APP_VERSION))) return;
    const version = APP_VERSION || 'antiga';
    // Antes da 0.3.0 (ou sem versão no app) não há atualização automática: avisa na hora. Nas
    // outras, espera um minuto para dar tempo de a atualização automática baixar.
    if (!APP_VERSION || newer('0.3.0', APP_VERSION)) {
      setOutdated(version);
      return;
    }
    const timer = setTimeout(() => setOutdated(version), 60000);
    return () => clearTimeout(timer);
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

  const closeNotes = () => {
    writeSeen(SITE_VERSION);
    setNotes([]);
  };
  const isApp = Boolean(appVersion);
  const update = () => {
    setBusy(true);
    if (isApp) void desktop?.installUpdate?.();
    else location.reload();
  };

  return (
    <>
      {outdated && !isApp && (
        <div className="update-card" role="alert">
          <img src="/nimbo-icon-128.png" alt="" />
          <div className="update-text">
            <strong>Seu app do Nimbo está desatualizado</strong>
            <span>
              Você está com a versão {outdated} e a atual é a {SITE_VERSION}.{' '}
              {APP_VERSION && !newer('0.3.0', APP_VERSION)
                ? 'A atualização automática não chegou: feche e abra o Nimbo. Se continuar, baixe o instalador novo.'
                : 'Esta versão não se atualiza sozinha: baixe o instalador novo e abra. Seu login continua salvo.'}
            </span>
            <div className="update-actions">
              <button
                className="button primary small"
                onClick={() => window.open('https://golive-ad118.web.app/baixar/', '_blank')}
              >
                <Download size={15} />
                Baixar app novo
              </button>
              <button className="button ghost small" onClick={() => setOutdated('')}>
                Depois
              </button>
            </div>
          </div>
        </div>
      )}
      {(isApp || site) && cardClosed && (
        <button
          className="update-pill"
          disabled={busy}
          title={live ? 'Sua live cai por alguns segundos ao atualizar' : undefined}
          onClick={update}
        >
          <Download size={14} />
          Atualização disponível
        </button>
      )}
      {(isApp || site) && !cardClosed && (
        <div className="update-card" role="status">
          <img src="/nimbo-icon-128.png" alt="" />
          <div className="update-text">
            <strong>{isApp ? `Nimbo ${appVersion} está pronto` : 'Nova versão do Nimbo'}</strong>
            <span>
              {isApp ? 'Reinicie o app para usar.' : 'Atualize para ter as novidades.'}
              {live && ' Sua live cai por alguns segundos.'}
            </span>
            <div className="update-actions">
              <button className="button primary small" disabled={busy} onClick={update}>
                {isApp ? <Download size={15} /> : <RotateCw size={15} />}
                {isApp ? 'Reiniciar agora' : 'Atualizar'}
              </button>
              <button className="button ghost small" onClick={() => setCardClosed(true)}>
                Depois
              </button>
            </div>
          </div>
          <button className="icon-button tiny" aria-label="Fechar aviso" onClick={() => setCardClosed(true)}>
            <X size={14} />
          </button>
        </div>
      )}
      {notes.length > 0 && (
        <Modal
          title={`Novidades do Nimbo ${notes[0].version}`}
          kicker="ATUALIZADO"
          size="sm"
          onClose={closeNotes}
          footer={
            <button className="button primary" onClick={closeNotes}>
              Bora
            </button>
          }
        >
          <div className="release-notes">
            {notes.map((release) => (
              <section key={release.version}>
                {notes.length > 1 && (
                  <h3>
                    {release.version} <small className="muted">{release.date}</small>
                  </h3>
                )}
                <ul>
                  {release.items.map((item) => (
                    <li key={item}>
                      <Sparkles size={14} aria-hidden />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
