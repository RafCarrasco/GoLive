//! O que o programa auxiliar em C# (`desktop/native/NimboAudio.cs`) sabe sobre o sistema, em Rust:
//! janelas abertas, processos em execução, retângulo de uma janela e do monitor dela, trazer uma
//! janela de volta e vigiar um jogo (na frente, fora da frente, fechou).
//!
//! O áudio fica de fora: a captura por processo é outra parte do plano (docs/rust-app.md).
//! O binário `nimbo-native` imprime tudo no mesmo formato do C#, para comparar os dois lado a lado.

mod json;
mod process;
mod watch;
mod window;

pub use process::{ProcessInfo, list_processes};
pub use watch::{Watch, WatchEvent, WatchTarget, watch};
pub use window::{Rect, WindowGeometry, WindowInfo, list_windows, restore, window_info};

/// Identificador de janela do Windows (HWND) como número, igual ao que o C# imprime.
pub type Hwnd = isize;

/// Motivos de falha. O texto é o mesmo que o C# escreve depois de `ERROR `.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    WindowNotFound,
    MonitorNotFound,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Error::WindowNotFound => "janela não encontrada",
            Error::MonitorNotFound => "monitor não encontrado",
        })
    }
}

impl std::error::Error for Error {}

/// Texto de um buffer UTF-16 do Windows, até o primeiro zero (ou o buffer inteiro).
pub(crate) fn wide(buffer: &[u16]) -> String {
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}
