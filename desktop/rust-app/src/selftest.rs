//! Autoteste com o site de verdade carregado: `NIMBO_SELFTEST=<arquivo>` faz o app conferir a
//! ponte de dentro da página, gravar o que viu no arquivo e fechar. Serve para o CI e para quem
//! mexe na casca saber, sem clicar em nada, se o site carregou e se a ponte responde.
//!
//! A página não ganha nenhum comando por causa disto: o Rust injeta o script e lê a resposta
//! pelo título do documento. Sem a variável de ambiente nada aqui roda.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, WebviewWindow};

/// Prefixo do título que carrega o relatório.
const MARK: &str = "nimbo-selftest:";
/// Se a página não responder nesse tempo, o autoteste falha em vez de ficar aberto para sempre.
const TIMEOUT: Duration = Duration::from_secs(90);

const SCRIPT: &str = r#"(async () => {
  if (window.__nimboSelftest) return;
  window.__nimboSelftest = true;
  const say = (data) => { document.title = 'nimbo-selftest:' + JSON.stringify(data); };
  const settle = (promise) => Promise.resolve(promise).catch((e) => ({ thrown: String(e) }));
  const bridge = window.nimboDesktop;
  const seen = { url: location.href, top: window.top === window.self, bridge: typeof bridge };
  if (!bridge) return say({ ...seen, done: true });
  Object.assign(seen, {
    version: bridge.version,
    engine: bridge.engine,
    frozen: Object.isFrozen(bridge),
    keys: Object.keys(bridge).sort().join(','),
    cancelSignIn: await settle(bridge.cancelSignIn()),
    startAudio: await settle(bridge.startAudio()),
    onAudio: typeof bridge.onAudio('x', () => {}, () => {}),
    // Um comando do próprio Tauri que a página não recebeu: tem que ser recusado.
    ungranted: await window.__TAURI_INTERNALS__.invoke('plugin:app|version').then(() => 'ALLOWED', (e) => String(e)),
    // Sair do Nimbo tem que ser barrado. Se não for, a página some e este relatório nunca chega.
    navigation: await new Promise((resolve) => {
      location.assign('http://nimbo-selftest.invalid/');
      setTimeout(() => resolve('blocked, still at ' + location.origin), 1000);
    }),
  });
  if (!WITH_LOGIN) return say({ ...seen, done: true });
  // Um frame de outra origem (aqui, origem opaca) tenta começar um login pelos dois caminhos do
  // Tauri: fetch e, com o fetch quebrado de propósito, postMessage. Não pode conseguir: se
  // conseguisse, sairia um segundo link de login no stdout.
  seen.foreignFrame = await new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.sandbox = 'allow-scripts';
    frame.style.display = 'none';
    frame.srcdoc = `<script>
      const seen = { origin: String(self.origin), internals: typeof window.__TAURI_INTERNALS__, bridge: typeof window.nimboDesktop };
      const tell = () => parent.postMessage({ nimboFrame: seen }, '*');
      const attempt = (name) => {
        seen[name] = 'no answer';
        tell();
        const invoked = window.__TAURI_INTERNALS__.invoke('sign_in');
        invoked.then(() => { seen[name] = 'ANSWERED'; tell(); }, (e) => { seen[name] = 'rejected: ' + String(e); tell(); });
        return Promise.race([invoked.catch(() => {}), new Promise((done) => setTimeout(done, 1000))]);
      };
      tell();
      if (window.__TAURI_INTERNALS__) {
        attempt('viaFetch').then(() => {
          window.fetch = () => Promise.reject(new Error('fetch quebrado pelo teste'));
          return attempt('viaPostMessage');
        });
      }
    <\/script>`;
    let last = 'frame script did not run';
    addEventListener('message', (event) => {
      if (event.source === frame.contentWindow && event.data && event.data.nimboFrame) last = event.data.nimboFrame;
    });
    document.body.append(frame);
    setTimeout(() => { frame.remove(); resolve(last); }, 4000);
  });
  say({ ...seen, done: false });
  const result = await settle(bridge.signIn());
  // Só o tamanho: token não vai para relatório, nem os de mentira.
  const signIn = result.ok
    ? { ok: true, idTokenLength: result.value.idToken.length, accessTokenLength: result.value.accessToken.length }
    : result;
  say({ signIn, done: true });
})();"#;

/// Arquivo do relatório, quando o autoteste foi pedido.
pub fn requested() -> Option<PathBuf> {
    std::env::var_os("NIMBO_SELFTEST")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

/// Encerra o app com erro se o relatório não chegar a tempo.
pub fn arm_timeout(app: AppHandle, report: PathBuf) {
    std::thread::spawn(move || {
        std::thread::sleep(TIMEOUT);
        record(&report, "timeout");
        app.exit(1);
    });
}

/// A página do Nimbo terminou de carregar: anota o endereço e roda o script de conferência.
pub fn page_loaded(window: &WebviewWindow, url: &str, report: &Path) {
    record(report, &format!("loaded {url}"));
    // Com NIMBO_LOGIN_PRINT o teste também percorre o login (o link sai no stdout, sem navegador).
    let with_login = std::env::var_os("NIMBO_LOGIN_PRINT").is_some();
    let script = SCRIPT.replace("WITH_LOGIN", if with_login { "true" } else { "false" });
    if let Err(e) = window.eval(script) {
        record(report, &format!("eval failed: {e}"));
    }
}

/// Título novo na página: se for um relatório, grava; se for o último, fecha o app.
pub fn title_changed(app: &AppHandle, title: &str, report: &Path) {
    let Some(payload) = title.strip_prefix(MARK) else {
        return;
    };
    record(report, &format!("report {payload}"));
    if payload.ends_with("\"done\":true}") {
        app.exit(0);
    }
}

fn record(report: &Path, line: &str) {
    let written = OpenOptions::new()
        .create(true)
        .append(true)
        .open(report)
        .and_then(|mut file| writeln!(file, "{line}"));
    if let Err(e) = written {
        eprintln!(
            "[nimbo] autoteste: não deu para gravar em {}: {e}",
            report.display()
        );
    }
}
