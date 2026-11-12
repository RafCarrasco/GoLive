//! Miniaturas das telas e janelas para o seletor "o que transmitir".
//!
//! A imagem vem do GDI (`gdi.rs`): `PrintWindow` com o conteúdo completo para janelas e cópia da
//! tela para monitores. É o que o Chromium faz no seletor do Electron. A alternativa, o Windows
//! Graphics Capture (o caminho da live), foi medida e descartada para miniaturas: o primeiro uso
//! custa uns 300 ms para ligar a placa de vídeo, cada miniatura abre uma sessão de captura
//! inteira, e no Windows 10 cada sessão pisca uma borda amarela em volta da janela, a cada
//! atualização do seletor.

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowDisplayAffinity, IsHungAppWindow, IsIconic, IsWindow, IsWindowVisible,
};

use crate::imaging::{self, Bitmap, ImageFormat};
use crate::window::handle;
use crate::{Error, Hwnd, gdi, monitor};

/// O que capturar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureTarget {
    /// Monitor pelo índice de [`crate::list_monitors`] (a partir de 1).
    Monitor(usize),
    Window(Hwnd),
}

/// Uma miniatura pronta para mostrar: o arquivo de imagem e o tamanho dela.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thumbnail {
    pub width: u32,
    pub height: u32,
    pub format: ImageFormat,
    /// O arquivo inteiro (JPEG ou PNG), não os pixels.
    pub data: Vec<u8>,
}

/// Miniatura em JPEG que cabe em `max_width` x `max_height`, mantendo a proporção e sem ampliar.
///
/// JPEG porque miniatura não tem transparência e o arquivo sai várias vezes menor que em PNG, o
/// que conta quando o seletor pede umas vinte de uma vez e de novo a cada poucos segundos.
///
/// Janela que não pode ser fotografada devolve o motivo ([`Error::Minimized`],
/// [`Error::Cloaked`], [`Error::Protected`]...) em vez de uma imagem preta.
pub fn capture_thumbnail(
    target: CaptureTarget,
    max_width: u32,
    max_height: u32,
) -> Result<Thumbnail, Error> {
    capture_thumbnail_as(target, max_width, max_height, ImageFormat::Jpeg)
}

/// O mesmo que [`capture_thumbnail`], escolhendo o formato do arquivo.
pub fn capture_thumbnail_as(
    target: CaptureTarget,
    max_width: u32,
    max_height: u32,
    format: ImageFormat,
) -> Result<Thumbnail, Error> {
    let bitmap = match target {
        CaptureTarget::Monitor(index) => {
            gdi::screen(monitor::rect_of(index)?, max_width, max_height)?
        }
        CaptureTarget::Window(hwnd) => {
            let hwnd = handle(hwnd);
            capturable(hwnd)?;
            gdi::window(hwnd, max_width, max_height)?
        }
    };
    finish(bitmap, format)
}

fn finish(bitmap: Bitmap, format: ImageFormat) -> Result<Thumbnail, Error> {
    // Imagem toda preta é o que o Windows entrega quando não consegue (ou não pode) mostrar a
    // janela; melhor dizer que não há prévia do que mostrar um retângulo preto como se fosse.
    if bitmap.is_black() {
        return Err(Error::Blank);
    }
    Ok(Thumbnail {
        width: bitmap.width,
        height: bitmap.height,
        format,
        data: imaging::encode(&bitmap, format)?,
    })
}

/// Motivos conhecidos para uma janela não ter imagem, conferidos antes de tentar.
fn capturable(hwnd: HWND) -> Result<(), Error> {
    let mut cloaked = 0u32;
    let mut affinity = 0u32;
    // SAFETY: consultas sobre um HWND; `cloaked` e `affinity` são locais com os 4 bytes
    // informados. Se a janela fechar no meio, as consultas só devolvem falso ou erro.
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err(Error::WindowNotFound);
        }
        if IsIconic(hwnd).as_bool() {
            return Err(Error::Minimized);
        }
        if !IsWindowVisible(hwnd).as_bool() {
            return Err(Error::Hidden);
        }
        let known = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&raw mut cloaked).cast(), 4);
        if known.is_ok() && cloaked != 0 {
            return Err(Error::Cloaked);
        }
        // Janela que pediu para não aparecer em capturas (bancos, vídeo com proteção).
        if GetWindowDisplayAffinity(hwnd, &mut affinity).is_ok() && affinity != 0 {
            return Err(Error::Protected);
        }
        // Pedir a imagem de uma janela travada pode travar quem pede.
        if IsHungAppWindow(hwnd).as_bool() {
            return Err(Error::Unresponsive);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bitmap(pixel: [u8; 4]) -> Bitmap {
        Bitmap {
            width: 2,
            height: 2,
            bgra: pixel.repeat(4),
        }
    }

    #[test]
    fn missing_targets_are_clear_errors() {
        assert_eq!(
            capture_thumbnail(CaptureTarget::Window(0), 400, 250),
            Err(Error::WindowNotFound)
        );
        assert_eq!(
            capture_thumbnail(CaptureTarget::Monitor(0), 400, 250),
            Err(Error::MonitorNotFound)
        );
        assert_eq!(
            capture_thumbnail(CaptureTarget::Monitor(999), 400, 250),
            Err(Error::MonitorNotFound)
        );
    }

    #[test]
    fn every_monitor_gives_a_thumbnail_that_fits() {
        for monitor in crate::list_monitors() {
            match capture_thumbnail(CaptureTarget::Monitor(monitor.index), 400, 250) {
                Ok(thumbnail) => {
                    assert_eq!(thumbnail.format, ImageFormat::Jpeg);
                    assert_eq!(thumbnail.data[..3], [0xFF, 0xD8, 0xFF]);
                    assert!(thumbnail.width <= 400 && thumbnail.height <= 250);
                    // Encosta em pelo menos um dos limites: reduziu só o necessário.
                    assert!(thumbnail.width == 400 || thumbnail.height == 250);
                }
                // Sessão sem tela de verdade (serviço, CI): a cópia vem preta ou é recusada.
                Err(error) => assert!(matches!(error, Error::Blank | Error::Os(_)), "{error}"),
            }
        }
    }

    #[test]
    fn a_black_capture_is_an_error_not_a_thumbnail() {
        assert_eq!(
            finish(bitmap([0, 0, 0, 255]), ImageFormat::Jpeg),
            Err(Error::Blank)
        );
        let grey = finish(bitmap([40, 40, 40, 255]), ImageFormat::Png).unwrap();
        assert_eq!((grey.width, grey.height), (2, 2));
        assert_eq!(grey.format, ImageFormat::Png);
        assert_eq!(grey.data[..4], *b"\x89PNG");
    }
}
