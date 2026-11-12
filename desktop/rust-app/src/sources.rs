//! "O que você quer compartilhar?": a lista de telas e janelas, com miniatura e ícone, para o
//! seletor que o site desenha (contrato em `src/desktop.ts`, `media.sources/thumbnail/icon`).
//! Os dados vêm de `nimbo-native`, que reproduz as regras do seletor do app antigo.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use nimbo_native::{
    CaptureTarget, IconSource, PickerSource, SourceKind, app_icon, capture_thumbnail,
    list_monitors, picker_sources, window_info,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::bridge::{FromApp, Reply};

/// Tamanho máximo das miniaturas do seletor.
const THUMB: (u32, u32) = (400, 250);
const ICON: u32 = 32;

/// A última lista entregue à página. Miniatura e ícone só saem para itens desta lista: a página
/// não escolhe janelas por conta própria.
#[derive(Default)]
pub struct Sources {
    last: Mutex<HashMap<String, PickerSource>>,
}

/// O que capturar, no formato do `media.start`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Capture {
    Monitor(usize),
    Window(isize),
}

#[derive(Serialize)]
pub struct SourceOut {
    id: String,
    kind: &'static str,
    title: String,
    app: String,
    minimized: bool,
    fullscreen: bool,
    game: bool,
    source: Capture,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
}

fn primary_monitor() -> usize {
    list_monitors()
        .into_iter()
        .find(|m| m.primary)
        .map_or(1, |m| m.index)
}

/// Jogo em tela cheia (ou sem janela listável) é transmitido pelo monitor dele: capturar a janela
/// de um jogo em tela cheia costuma dar imagem preta ou congelada.
fn capture_for(source: &PickerSource) -> Capture {
    match source.kind {
        SourceKind::Screen => Capture::Monitor(source.monitor),
        SourceKind::Game => Capture::Monitor(primary_monitor()),
        SourceKind::Window if source.fullscreen && source.game => {
            let monitor = window_info(source.hwnd).ok().and_then(|geometry| {
                list_monitors()
                    .into_iter()
                    .find(|m| m.rect == geometry.monitor)
                    .map(|m| m.index)
            });
            Capture::Monitor(monitor.unwrap_or_else(primary_monitor))
        }
        SourceKind::Window => Capture::Window(source.hwnd),
    }
}

fn describe(source: &PickerSource) -> SourceOut {
    SourceOut {
        id: source.id.clone(),
        kind: if source.kind == SourceKind::Screen {
            "screen"
        } else {
            "window"
        },
        title: source.title.clone(),
        app: source
            .exe
            .strip_suffix(".exe")
            .unwrap_or(&source.exe)
            .to_owned(),
        minimized: source.minimized,
        fullscreen: source.fullscreen,
        game: source.game,
        source: capture_for(source),
        pid: (source.pid != 0).then_some(source.pid),
    }
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

/// Telas e janelas que dá para transmitir agora, na ordem do seletor (telas, depois jogos e janelas).
#[tauri::command]
pub async fn media_sources(_caller: FromApp, app: AppHandle) -> Reply<Vec<SourceOut>> {
    let listed = tauri::async_runtime::spawn_blocking(move || {
        let sources = picker_sources(&[]);
        let out: Vec<SourceOut> = sources.iter().map(describe).collect();
        let state = app.state::<Sources>();
        *state.last.lock().unwrap_or_else(|e| e.into_inner()) =
            sources.into_iter().map(|s| (s.id.clone(), s)).collect();
        out
    })
    .await;
    match listed {
        Ok(out) => Reply::ok(out),
        Err(_) => Reply::error("Não foi possível listar telas e janelas."),
    }
}

fn find(app: &AppHandle, id: &str) -> Option<PickerSource> {
    app.state::<Sources>()
        .last
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
}

/// Miniatura de um item da lista. `null` quando não dá para capturar (minimizada, protegida).
#[tauri::command]
pub async fn media_thumbnail(
    _caller: FromApp,
    app: AppHandle,
    id: String,
) -> Reply<Option<String>> {
    let Some(source) = find(&app, &id) else {
        return Reply::ok(None);
    };
    let target = match source.kind {
        SourceKind::Screen => CaptureTarget::Monitor(source.monitor),
        SourceKind::Window => CaptureTarget::Window(source.hwnd),
        // Jogo sem janela não tem o que mostrar; o seletor usa o ícone.
        SourceKind::Game => return Reply::ok(None),
    };
    let image = tauri::async_runtime::spawn_blocking(move || {
        capture_thumbnail(target, THUMB.0, THUMB.1).ok()
    })
    .await;
    Reply::ok(
        image
            .ok()
            .flatten()
            .map(|thumb| data_url("image/jpeg", &thumb.data)),
    )
}

/// Ícone do aplicativo de um item da lista.
#[tauri::command]
pub async fn media_icon(_caller: FromApp, app: AppHandle, id: String) -> Reply<Option<String>> {
    let Some(source) = find(&app, &id) else {
        return Reply::ok(None);
    };
    if source.kind == SourceKind::Screen {
        return Reply::ok(None);
    }
    let icon = tauri::async_runtime::spawn_blocking(move || {
        let from_window = (source.hwnd != 0)
            .then(|| app_icon(IconSource::Window(source.hwnd), ICON).ok())
            .flatten();
        from_window.or_else(|| {
            (!source.path.is_empty())
                .then(|| app_icon(IconSource::Exe(&source.path), ICON).ok())
                .flatten()
        })
    })
    .await;
    Reply::ok(icon.ok().flatten().map(|png| data_url("image/png", &png)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(kind: SourceKind) -> PickerSource {
        PickerSource {
            id: "window:42".into(),
            kind,
            title: "Jogo".into(),
            exe: "jogo.exe".into(),
            path: String::new(),
            hwnd: 42,
            pid: 7,
            monitor: 0,
            minimized: false,
            fullscreen: false,
            game: false,
        }
    }

    #[test]
    fn a_window_is_described_the_way_the_site_expects() {
        let json = serde_json::to_value(describe(&source(SourceKind::Window))).unwrap();
        assert_eq!(json["kind"], "window");
        assert_eq!(json["app"], "jogo");
        assert_eq!(json["source"], serde_json::json!({ "window": 42 }));
        assert_eq!(json["pid"], 7);
    }

    #[test]
    fn a_screen_is_captured_by_its_monitor_index() {
        let mut screen = source(SourceKind::Screen);
        screen.monitor = 2;
        screen.pid = 0;
        let json = serde_json::to_value(describe(&screen)).unwrap();
        assert_eq!(json["kind"], "screen");
        assert_eq!(json["source"], serde_json::json!({ "monitor": 2 }));
        assert!(json.get("pid").is_none());
    }

    #[test]
    fn images_travel_as_data_urls() {
        assert_eq!(data_url("image/png", b"abc"), "data:image/png;base64,YWJj");
    }
}
