//! Casca do Nimbo em Rust (Tauri 2): uma janela que abre o Nimbo publicado no WebView2 do
//! Windows e expõe ao site a mesma ponte do app em Electron (`window.nimboDesktop`).
//! Plano em `docs/rust-app.md`; o contrato da ponte está em `src/desktop.ts`.
//!
//! Variáveis de ambiente, todas opcionais e só para teste:
//! - `NIMBO_URL`: outro endereço no lugar do site publicado (ex.: `http://localhost:5173`).
//! - `NIMBO_APP_ID`: outro identificador, para não dividir trava de instância única nem dados.
//! - `NIMBO_DATA_DIR`: pasta dos dados do WebView2 (cookies, login) no lugar da padrão.
//! - `NIMBO_LOGIN_PRINT`: escreve o link de login no stdout em vez de abrir o navegador.
//! - `NIMBO_SELFTEST=<arquivo>`: confere a ponte com o site carregado e fecha (ver `selftest.rs`).

// Sem janela de console atrás do app instalado.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod login;
mod selftest;

use std::path::PathBuf;
use std::process::ExitCode;

use tauri::ipc::CapabilityBuilder;
use tauri::webview::{Color, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::{Origin, Url};

use bridge::{MAIN_WINDOW, Shell};

const PRODUCTION_URL: &str = "https://golive-ad118.web.app";

/// Opções do Chromium dentro do WebView2. Passar esta lista substitui a padrão do wry, por isso
/// os três primeiros recursos desligados (dele) continuam aqui.
///
/// O resto repete o que o app em Electron já faz: o Nimbo transmite ao vivo, e com a janela
/// atrás do jogo ou minimizada o Chromium freava a página (a live caía de ~58 para ~1 quadro/s).
/// O Electron também deixa vídeo com som tocar sem clique; o WebView2, por padrão, não.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,\
CalculateNativeWinOcclusion,IntensiveWakeUpThrottling \
--disable-renderer-backgrounding --disable-background-timer-throttling \
--disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required";

fn main() -> ExitCode {
    let app_url = match app_url(std::env::var("NIMBO_URL").ok().as_deref()) {
        Ok(url) => url,
        Err(reason) => {
            eprintln!("[nimbo] NIMBO_URL inválida: {reason}");
            return ExitCode::from(2);
        }
    };
    let mut context = tauri::generate_context!();
    if let Ok(identifier) = std::env::var("NIMBO_APP_ID") {
        if !valid_identifier(&identifier) {
            eprintln!("[nimbo] NIMBO_APP_ID inválido: use letras, números, ponto e hífen");
            return ExitCode::from(2);
        }
        // O identificador dá nome à trava de instância única e à pasta de dados do WebView2.
        context.config_mut().identifier = identifier;
    }
    let shell = Shell {
        origin: app_url.origin(),
        app_url,
        logins: login::LoginManager::default(),
    };

    let run = tauri::Builder::default()
        // Segunda abertura do app: traz a janela que já existe para a frente e sai.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main(app);
        }))
        .manage(shell)
        .invoke_handler(tauri::generate_handler![
            bridge::sign_in,
            bridge::cancel_sign_in
        ])
        .setup(|app| {
            open_main_window(app.handle())?;
            Ok(())
        })
        .run(context);
    match run {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("[nimbo] o app não abriu: {e}");
            ExitCode::FAILURE
        }
    }
}

fn open_main_window(app: &AppHandle) -> tauri::Result<()> {
    let shell = app.state::<Shell>();
    let origin = shell.origin.clone();

    // A única permissão do app: a página do Nimbo, na janela principal, pode chamar os dois
    // comandos de login. Nenhum comando do próprio Tauri (janela, eventos, arquivos...) é
    // liberado, e nada vale para outra origem. Feita aqui, e não em arquivo, porque a origem
    // muda com NIMBO_URL.
    app.add_capability(
        CapabilityBuilder::new("nimbo-bridge")
            .local(false)
            .remote(origin.ascii_serialization())
            .window(MAIN_WINDOW)
            .permission("allow-sign-in")
            .permission("allow-cancel-sign-in"),
    )?;

    let selftest = selftest::requested();
    let mut window = WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW,
        WebviewUrl::External(shell.app_url.clone()),
    )
    .title("Nimbo")
    .inner_size(1280.0, 800.0)
    .min_inner_size(850.0, 590.0)
    .center()
    // Mesma cor de fundo do site: sem clarão branco enquanto ele carrega.
    .background_color(Color(0x0b, 0x10, 0x20, 0xff))
    // O tratador de arrastar do Tauri engole o arrastar-e-soltar da própria página.
    .disable_drag_drop_handler()
    .additional_browser_args(BROWSER_ARGS)
    .initialization_script(bridge::script(&origin))
    // A janela nunca sai do Nimbo; link para fora abre no navegador do sistema.
    .on_navigation({
        let origin = origin.clone();
        move |url| {
            let stays = stays_in_app(url, &origin);
            if !stays {
                open_in_browser(url);
            }
            stays
        }
    })
    .on_new_window(|url, _features| {
        open_in_browser(&url);
        NewWindowResponse::Deny
    });
    if let Some(directory) = std::env::var_os("NIMBO_DATA_DIR").filter(|dir| !dir.is_empty()) {
        window = window.data_directory(PathBuf::from(directory));
    }
    if let Some(report) = selftest {
        selftest::arm_timeout(app.clone(), report.clone());
        window = window
            .on_page_load({
                let report = report.clone();
                move |window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        selftest::page_loaded(&window, payload.url().as_str(), &report);
                    }
                }
            })
            .on_document_title_changed(move |window, title| {
                selftest::title_changed(window.app_handle(), &title, &report);
            });
    }
    window.build()?;
    Ok(())
}

/// Traz a janela principal para a frente (segunda abertura do app, fim do login).
pub fn focus_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    // Falhar aqui só deixa a janela onde estava; não há o que fazer além disso.
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Endereço que a janela carrega: `NIMBO_URL`, ou o site publicado.
fn app_url(configured: Option<&str>) -> Result<Url, String> {
    let text = configured
        .filter(|text| !text.is_empty())
        .unwrap_or(PRODUCTION_URL);
    let url = Url::parse(text).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") || !url.origin().is_tuple() {
        return Err("precisa ser um endereço http(s)".into());
    }
    Ok(url)
}

fn valid_identifier(identifier: &str) -> bool {
    !identifier.is_empty()
        && identifier.len() <= 100
        && identifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// A janela só navega dentro da origem do Nimbo.
fn stays_in_app(url: &Url, app: &Origin) -> bool {
    url.origin() == *app
}

/// Só https vai para o navegador do sistema, como no app em Electron. O resto é ignorado.
fn opens_in_browser(url: &Url) -> bool {
    url.scheme() == "https"
}

fn open_in_browser(url: &Url) {
    if !opens_in_browser(url) {
        return;
    }
    if let Err(e) = open::that_detached(url.as_str()) {
        eprintln!("[nimbo] não deu para abrir o navegador: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_the_published_site_unless_nimbo_url_says_otherwise() {
        assert_eq!(
            app_url(None).unwrap().as_str(),
            "https://golive-ad118.web.app/"
        );
        assert_eq!(
            app_url(Some("")).unwrap().as_str(),
            "https://golive-ad118.web.app/"
        );
        assert_eq!(
            app_url(Some("http://localhost:5173")).unwrap().as_str(),
            "http://localhost:5173/"
        );
        for bad in [
            "nimbo",
            "file:///C:/x.html",
            "data:text/html,oi",
            "javascript:alert(1)",
        ] {
            assert!(app_url(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn navigation_stays_inside_the_app_origin() {
        let app = Url::parse(PRODUCTION_URL).unwrap().origin();
        let stays = |url: &str| stays_in_app(&Url::parse(url).unwrap(), &app);
        assert!(stays("https://golive-ad118.web.app/"));
        assert!(stays("https://golive-ad118.web.app/canal/abc?x=1#y"));
        for outside in [
            "https://evil.invalid/",
            "http://golive-ad118.web.app/",
            "https://golive-ad118.web.app.evil.invalid/",
            "https://golive-ad118.firebaseapp.com/",
            "https://accounts.google.com/o/oauth2/auth",
            "about:blank",
            "data:text/html,oi",
            "file:///C:/Windows/win.ini",
        ] {
            assert!(!stays(outside), "{outside}");
        }
    }

    #[test]
    fn only_https_links_go_to_the_system_browser() {
        let opens = |url: &str| opens_in_browser(&Url::parse(url).unwrap());
        assert!(opens("https://example.com/pagina"));
        for ignored in [
            "http://example.com/",
            "file:///C:/Windows/System32/calc.exe",
            "ms-settings:privacy",
            "javascript:alert(1)",
            "data:text/html,oi",
        ] {
            assert!(!opens(ignored), "{ignored}");
        }
    }

    #[test]
    fn identifier_override_accepts_only_safe_names() {
        assert!(valid_identifier("app.nimbo.rusttest"));
        assert!(valid_identifier("app.nimbo-beta.1"));
        for bad in ["", "app nimbo", "app/nimbo", "..\\x", "app.nimbo\u{e9}"] {
            assert!(!valid_identifier(bad), "{bad}");
        }
    }
}
