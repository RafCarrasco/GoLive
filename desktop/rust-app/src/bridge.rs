//! Ponte com o site: o script que cria `window.nimboDesktop` e os comandos que ele chama.
//! O contrato é o de `desktop/preload.cjs` + `src/desktop.ts`: toda resposta é
//! `{ ok: true, value }` ou `{ ok: false, error }`, e quem não é o Nimbo recebe "Unauthorized".

use serde::Serialize;
use tauri::ipc::{CommandArg, CommandItem, InvokeError};
use tauri::{AppHandle, Manager, Runtime};
use url::{Origin, Url};

use crate::login::{self, LoginManager, Outcome, Timing};

/// Rótulo da única janela (e do webview dela).
pub const MAIN_WINDOW: &str = "main";

/// O que os comandos precisam saber sobre o app em execução.
pub struct Shell {
    /// Endereço do Nimbo carregado na janela (`NIMBO_URL` ou o site publicado).
    pub app_url: Url,
    /// A única origem que pode falar com o app.
    pub origin: Origin,
    pub logins: LoginManager,
}

/// Script injetado antes dos scripts da página.
pub fn script(origin: &Origin) -> String {
    let origin =
        serde_json::to_string(&origin.ascii_serialization()).expect("uma string sempre vira JSON");
    include_str!("bridge.js").replace("__NIMBO_APP_ORIGIN__", &origin)
}

/// Prova de que o comando foi chamado pela página do Nimbo na janela principal. Todo comando
/// recebe um `FromApp`; se a conferência falha, o comando nem começa a rodar.
///
/// É a segunda barreira. A primeira é a capability do Tauri (ver `main.rs`), que já recusa
/// qualquer frame cuja origem não seja a do Nimbo.
pub struct FromApp;

impl<'de, R: Runtime> CommandArg<'de, R> for FromApp {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let webview = command.message.webview_ref();
        let shell = webview.state::<Shell>();
        let page = webview.url().ok();
        // Quando a chamada vem por fetch, o navegador informa a origem do frame que chamou, e a
        // página não consegue forjar esse cabeçalho.
        let frames = command
            .message
            .headers()
            .get_all("origin")
            .iter()
            .map(|value| value.as_bytes());
        if caller_allowed(webview.label(), page.as_ref(), frames, &shell.origin) {
            Ok(Self)
        } else {
            Err(InvokeError::from("Unauthorized"))
        }
    }
}

/// Só a janela principal, com o Nimbo carregado, e nenhum frame de outra origem.
fn caller_allowed<'a>(
    label: &str,
    page: Option<&Url>,
    mut frame_origins: impl Iterator<Item = &'a [u8]>,
    app: &Origin,
) -> bool {
    let from_app = |url: &Url| url.origin() == *app;
    label == MAIN_WINDOW
        && page.is_some_and(from_app)
        && frame_origins.all(|raw| {
            std::str::from_utf8(raw)
                .ok()
                .and_then(|text| Url::parse(text).ok())
                .is_some_and(|url| from_app(&url))
        })
}

/// Resposta no formato que o `src/desktop.ts` espera.
#[derive(Debug, Serialize)]
pub struct Reply<T> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Reply<()> {
    /// Deu certo e não há o que devolver.
    pub fn done() -> Self {
        Self {
            ok: true,
            value: None,
            error: None,
        }
    }
}

impl<T> Reply<T> {
    pub fn ok(value: T) -> Self {
        Self {
            ok: true,
            value: Some(value),
            error: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(message.into()),
        }
    }
}

// Sem `Debug`: token não pode aparecer em log.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    id_token: String,
    access_token: String,
}

/// Abre o login do Google no navegador do sistema e espera a credencial voltar.
#[tauri::command]
pub async fn sign_in(_caller: FromApp, app: AppHandle) -> Reply<Tokens> {
    let login = {
        let shell = app.state::<Shell>();
        let login = match shell.logins.begin(Timing::default()) {
            Ok(login) => login,
            Err(e) => return Reply::error(format!("Não foi possível iniciar o login: {e}")),
        };
        let url = login::login_url(shell.app_url.as_str(), login.port, &login.state);
        // O link leva só a porta e o código de uso único; a credencial nunca passa por aqui.
        if std::env::var_os("NIMBO_LOGIN_PRINT").is_some() {
            println!("[nimbo] login: {url}");
        } else if let Err(e) = open::that_detached(&url) {
            return Reply::error(format!("Não foi possível abrir o navegador: {e}"));
        }
        login
    };
    // A espera pode durar os 5 minutos inteiros: fica numa thread própria, fora da interface.
    let outcome = tauri::async_runtime::spawn_blocking(move || login.wait())
        .await
        .unwrap_or(Outcome::Cancelled);
    match outcome {
        Outcome::SignedIn(credentials) => {
            crate::focus_main(&app);
            Reply::ok(Tokens {
                id_token: credentials.id_token,
                access_token: credentials.access_token,
            })
        }
        Outcome::MissingCredential => {
            crate::focus_main(&app);
            Reply::error(login::MISSING_CREDENTIAL)
        }
        Outcome::Cancelled => Reply::error(login::CANCELLED),
        Outcome::Expired => Reply::error(login::EXPIRED),
    }
}

/// Desiste do login em andamento (o `signIn` pendente responde "Login cancelado.").
#[tauri::command]
pub async fn cancel_sign_in(_caller: FromApp, app: AppHandle) -> Reply<()> {
    app.state::<Shell>().logins.cancel();
    Reply {
        ok: true,
        value: None,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const SITE: &str = "https://golive-ad118.web.app";

    fn origin(url: &str) -> Origin {
        Url::parse(url).unwrap().origin()
    }

    fn allowed(label: &str, page: Option<&str>, frames: &[&[u8]]) -> bool {
        let page = page.map(|page| Url::parse(page).unwrap());
        caller_allowed(label, page.as_ref(), frames.iter().copied(), &origin(SITE))
    }

    #[test]
    fn only_the_app_page_in_the_main_window_may_call() {
        let page = Some("https://golive-ad118.web.app/canal/abc?x=1#y");
        assert!(allowed(MAIN_WINDOW, page, &[]));
        assert!(allowed(MAIN_WINDOW, page, &[SITE.as_bytes()]));

        assert!(!allowed("outra", page, &[]));
        assert!(!allowed(MAIN_WINDOW, None, &[]));
        for elsewhere in [
            "https://evil.invalid/",
            "http://golive-ad118.web.app/",
            "https://golive-ad118.web.app:8443/",
            "https://golive-ad118.web.app.evil.invalid/",
            "https://sub.golive-ad118.web.app/",
            "about:blank",
            "data:text/html,oi",
        ] {
            assert!(!allowed(MAIN_WINDOW, Some(elsewhere), &[]), "{elsewhere}");
        }
    }

    #[test]
    fn a_frame_from_another_origin_inside_the_app_page_is_refused() {
        let page = Some(SITE);
        for frame in [
            &b"https://evil.invalid"[..],
            b"null",
            b"",
            b"\xff\xfe",
            b"http://golive-ad118.web.app",
        ] {
            assert!(
                !allowed(MAIN_WINDOW, page, &[frame]),
                "{}",
                String::from_utf8_lossy(frame)
            );
        }
        // Um cabeçalho bom não salva outro ruim.
        assert!(!allowed(
            MAIN_WINDOW,
            page,
            &[SITE.as_bytes(), b"https://evil.invalid"]
        ));
    }

    #[test]
    fn local_test_address_is_matched_with_its_port() {
        let app = origin("http://localhost:5173/");
        let page = Url::parse("http://localhost:5173/desktop-login").unwrap();
        let other = Url::parse("http://localhost:5174/").unwrap();
        assert!(caller_allowed(
            MAIN_WINDOW,
            Some(&page),
            std::iter::empty(),
            &app
        ));
        assert!(!caller_allowed(
            MAIN_WINDOW,
            Some(&other),
            std::iter::empty(),
            &app
        ));
    }

    #[test]
    fn replies_have_the_shape_the_site_expects() {
        let json = |reply: Reply<Tokens>| serde_json::to_string(&reply).unwrap();
        let tokens = Tokens {
            id_token: "a".into(),
            access_token: "b".into(),
        };
        assert_eq!(
            json(Reply::ok(tokens)),
            r#"{"ok":true,"value":{"idToken":"a","accessToken":"b"}}"#
        );
        assert_eq!(
            json(Reply::error("Login cancelado.")),
            r#"{"ok":false,"error":"Login cancelado."}"#
        );
    }

    #[test]
    fn script_carries_the_origin_as_a_js_string() {
        let script = script(&origin("https://golive-ad118.web.app/qualquer/pagina"));
        assert!(script.contains(r#"location.origin !== "https://golive-ad118.web.app")"#));
        assert!(!script.contains("__NIMBO_APP_ORIGIN__"));
    }

    /// Nomes das chaves de um objeto literal, uma por linha, com exatamente este recuo.
    fn keys<'a>(source: &'a str, indent: &str) -> BTreeSet<&'a str> {
        source
            .lines()
            .filter_map(|line| line.strip_prefix(indent))
            .filter_map(|line| line.split_once(':'))
            .map(|(name, _)| name)
            .filter(|name| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric()))
            .collect()
    }

    #[test]
    fn bridge_has_every_method_of_the_electron_preload_plus_engine() {
        let preload = include_str!("../../preload.cjs");
        let bridge = include_str!("bridge.js");
        assert!(preload.contains("exposeInMainWorld('nimboDesktop'"));
        assert!(bridge.contains("defineProperty(window, 'nimboDesktop'"));

        let (_, object) = bridge.split_once("const bridge = {").unwrap();
        let (object, _) = object.split_once("\n  };").unwrap();
        let mut expected = keys(preload, "  ");
        assert!(
            expected.contains("signIn") && expected.contains("onAudio"),
            "{expected:?}"
        );
        assert!(expected.insert("engine"));
        // O motor de mídia só existe no app em Rust (ver media.rs).
        assert!(expected.insert("media"));
        assert_eq!(keys(object, "    "), expected);

        // Mesma versão de contrato que o Electron expõe.
        assert!(preload.contains("\n  version: 1,"));
        assert!(object.contains("\n    version: 1,"));
        assert!(object.contains("\n    engine: 'rust',"));
    }
}
