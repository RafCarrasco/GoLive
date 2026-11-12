//! Comandos do motor de mídia (`nimbo-media`): a página pede a captura e repassa a oferta WebRTC de
//! cada pessoa que quer assistir; o motor captura, codifica uma vez e envia para todos.
//! O contrato é o `media` de `src/desktop.ts` (ver também `src/live/native.ts`).

use nimbo_media::engine::{Engine, Quality, Source};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::bridge::{FromApp, Reply};

/// O motor é um só por app: uma captura, vários espectadores.
#[derive(Default)]
pub struct Media {
    engine: Engine,
}

/// `{ monitor: n }` ou `{ window: hwnd }`; sem fonte, a tela principal.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceArg {
    Monitor(usize),
    Window(isize),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityArg {
    fps: u32,
    bitrate: u32,
    max_height: u32,
}

impl QualityArg {
    /// A página é quem pede, mas os limites são do app: valores absurdos não chegam ao codificador.
    fn checked(&self) -> Quality {
        Quality {
            fps: self.fps.clamp(15, 60),
            bitrate: self.bitrate.clamp(500_000, 20_000_000),
            max_height: self.max_height.clamp(360, 2160),
        }
    }
}

#[derive(Serialize)]
pub struct Accepted {
    id: u64,
    answer: String,
}

/// Uma oferta WebRTC legítima tem poucos KB; acima disto nem tenta interpretar.
const MAX_OFFER: usize = 256 * 1024;

/// Começa (ou troca) a captura. Quem já assiste continua conectado.
#[tauri::command]
pub async fn media_start(
    _caller: FromApp,
    app: AppHandle,
    source: Option<SourceArg>,
    quality: QualityArg,
) -> Reply<()> {
    let source = match source {
        None => Source::PrimaryMonitor,
        Some(SourceArg::Monitor(index)) => Source::Monitor(index),
        Some(SourceArg::Window(hwnd)) => Source::Window(hwnd),
    };
    let quality = quality.checked();
    // Criar a captura fala com o Windows e pode demorar: fora da thread da interface.
    let started = tauri::async_runtime::spawn_blocking(move || {
        app.state::<Media>()
            .engine
            .start(source, quality)
            .map_err(|e| e.to_string())
    })
    .await;
    match started {
        Ok(Ok(())) => Reply::done(),
        Ok(Err(e)) => Reply::error(format!("Não foi possível capturar: {e}")),
        Err(_) => Reply::error("Não foi possível capturar."),
    }
}

/// Entrega ao motor a oferta de um espectador e devolve a resposta dele.
#[tauri::command]
pub async fn media_accept(_caller: FromApp, app: AppHandle, offer: String) -> Reply<Accepted> {
    if offer.len() > MAX_OFFER {
        return Reply::error("Oferta inválida.");
    }
    // Descobrir o endereço público (STUN) pode levar até ~1 s: fora da thread da interface.
    let accepted = tauri::async_runtime::spawn_blocking(move || {
        app.state::<Media>()
            .engine
            .accept(offer.as_bytes())
            .map_err(|e| e.to_string())
    })
    .await;
    match accepted {
        Ok(Ok((id, answer))) => match String::from_utf8(answer) {
            Ok(answer) => Reply::ok(Accepted { id, answer }),
            Err(_) => Reply::error("Resposta inválida do motor de vídeo."),
        },
        Ok(Err(e)) => Reply::error(format!("Não foi possível conectar o espectador: {e}")),
        Err(_) => Reply::error("Não foi possível conectar o espectador."),
    }
}

/// Encerra a conexão de um espectador.
#[tauri::command]
pub async fn media_close(_caller: FromApp, app: AppHandle, id: u64) -> Reply<()> {
    app.state::<Media>().engine.close(id);
    Reply::done()
}

/// Para a captura e desconecta todo mundo.
#[tauri::command]
pub async fn media_stop(_caller: FromApp, app: AppHandle) -> Reply<()> {
    let stopped =
        tauri::async_runtime::spawn_blocking(move || app.state::<Media>().engine.stop()).await;
    match stopped {
        Ok(()) => Reply::done(),
        Err(_) => Reply::error("Não foi possível parar a captura."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_follows_the_shape_the_site_sends() {
        let monitor: SourceArg = serde_json::from_str(r#"{"monitor":2}"#).unwrap();
        assert!(matches!(monitor, SourceArg::Monitor(2)));
        let window: SourceArg = serde_json::from_str(r#"{"window":65852}"#).unwrap();
        assert!(matches!(window, SourceArg::Window(65852)));
        let none: Option<SourceArg> = serde_json::from_str("null").unwrap();
        assert!(none.is_none());
        assert!(serde_json::from_str::<SourceArg>(r#"{"file":"c:/x"}"#).is_err());
    }

    #[test]
    fn quality_is_clamped_to_what_the_encoder_supports() {
        let wild: QualityArg =
            serde_json::from_str(r#"{"fps":1000,"bitrate":1,"maxHeight":99999}"#).unwrap();
        let q = wild.checked();
        assert_eq!((q.fps, q.bitrate, q.max_height), (60, 500_000, 2160));
        let normal: QualityArg =
            serde_json::from_str(r#"{"fps":60,"bitrate":6000000,"maxHeight":1080}"#).unwrap();
        let q = normal.checked();
        assert_eq!((q.fps, q.bitrate, q.max_height), (60, 6_000_000, 1080));
    }
}
