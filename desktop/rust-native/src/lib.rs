//! O que o programa auxiliar em C# (`desktop/native/NimboAudio.cs`) sabe sobre o sistema, em Rust:
//! janelas abertas, processos em execução, retângulo de uma janela e do monitor dela, trazer uma
//! janela de volta e vigiar um jogo (na frente, fora da frente, fechou).
//!
//! E o que o Electron dava de graça ao seletor "o que transmitir": os monitores, a lista de telas
//! e janelas a oferecer, a miniatura de cada uma e o ícone do aplicativo.
//!
//! O áudio fica de fora: a captura por processo é outra parte do plano (docs/rust-app.md).
//! O binário `nimbo-native` imprime os modos do C# no mesmo formato, para comparar os dois.

mod games;
mod gdi;
mod icon;
mod imaging;
mod json;
mod monitor;
mod picker;
mod process;
mod thumbnail;
mod watch;
mod window;

pub use games::{exe_of, game_name, is_game_like};
pub use icon::{IconSource, app_icon};
pub use imaging::ImageFormat;
pub use monitor::{MonitorInfo, list_monitors};
pub use picker::{PickerSource, SourceKind, picker_sources};
pub use process::{ProcessInfo, list_processes};
pub use thumbnail::{CaptureTarget, Thumbnail, capture_thumbnail, capture_thumbnail_as};
pub use watch::{Watch, WatchEvent, WatchTarget, watch};
pub use window::{Rect, WindowGeometry, WindowInfo, list_windows, restore, window_info};

/// Identificador de janela do Windows (HWND) como número, igual ao que o C# imprime.
pub type Hwnd = isize;

/// Motivos de falha. Nos modos que o C# também tem, o texto é o mesmo que ele escreve depois de
/// `ERROR `.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    WindowNotFound,
    MonitorNotFound,
    /// Janela minimizada: o Windows não guarda a imagem dela.
    Minimized,
    /// Janela que o próprio aplicativo escondeu.
    Hidden,
    /// Janela escondida pelo Windows (outra área de trabalho virtual, aplicativo suspenso).
    Cloaked,
    /// Janela que pediu para não aparecer em capturas de tela.
    Protected,
    /// Janela travada: pedir a imagem dela poderia travar quem pede.
    Unresponsive,
    /// A captura veio vazia ou toda preta: o Windows não entregou a imagem.
    Blank,
    /// Nem a janela nem o executável têm ícone (ou o executável não pôde ser lido).
    NoIcon,
    /// Uma chamada do Windows falhou; o número é o código dela (HRESULT).
    Os(i32),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Error::WindowNotFound => "janela não encontrada",
            Error::MonitorNotFound => "monitor não encontrado",
            Error::Minimized => "janela minimizada",
            Error::Hidden => "janela escondida",
            Error::Cloaked => "janela escondida pelo Windows",
            Error::Protected => "janela protegida contra captura",
            Error::Unresponsive => "janela não responde",
            Error::Blank => "captura sem imagem",
            Error::NoIcon => "sem ícone",
            Error::Os(code) => return write!(f, "falha do Windows 0x{code:08X}"),
        })
    }
}

impl std::error::Error for Error {}

impl From<windows::core::Error> for Error {
    fn from(error: windows::core::Error) -> Self {
        Error::Os(error.code().0)
    }
}

/// Texto de um buffer UTF-16 do Windows, até o primeiro zero (ou o buffer inteiro).
pub(crate) fn wide(buffer: &[u16]) -> String {
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}
