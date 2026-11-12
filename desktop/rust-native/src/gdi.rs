//! Captura de um quadro pelo GDI: a janela desenhada pelo próprio Windows (`PrintWindow`) e a
//! tela copiada do monitor. É síncrono, não precisa de placa de vídeo e não mostra nada na tela.

use std::ffi::c_void;

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC, CreateDIBSection,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GdiFlush, GetDC, HBITMAP, HDC, HGDIOBJ, ReleaseDC,
    SRCCOPY, SelectObject,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, PW_RENDERFULLCONTENT};

use crate::imaging::{Area, Bitmap, shrink};
use crate::window::PhysicalPixels;
use crate::{Error, Rect};

/// A janela inteira, como o Windows a compõe (inclusive conteúdo desenhado pela placa de vídeo),
/// já reduzida.
pub(crate) fn window(hwnd: HWND, max_width: u32, max_height: u32) -> Result<Bitmap, Error> {
    let _pixels = PhysicalPixels::enter();
    let mut outer = RECT::default();
    // SAFETY: `outer` é local; janela que não existe mais devolve erro.
    unsafe { GetWindowRect(hwnd, &mut outer) }.map_err(|_| Error::WindowNotFound)?;
    let canvas = Canvas::new(outer.right - outer.left, outer.bottom - outer.top)?;
    // SAFETY: `canvas.dc` é um contexto de memória vivo com um bitmap do tamanho da janela.
    // PW_RENDERFULLCONTENT pede a imagem ao compositor, que é quem tem o que a placa desenhou.
    let printed =
        unsafe { PrintWindow(hwnd, canvas.dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)) }.as_bool();
    if !printed {
        return Err(Error::Blank);
    }
    // O retângulo da janela inclui as bordas invisíveis de redimensionar; a miniatura mostra só
    // o que a pessoa vê.
    let area = visible_frame(hwnd)
        .map(|frame| canvas.area_of(&frame, &outer.into()))
        .unwrap_or_else(|| canvas.whole());
    Ok(shrink(
        canvas.pixels(),
        canvas.stride(),
        area,
        max_width,
        max_height,
    ))
}

/// O que está na tela dentro de `rect` (pixels físicos da área de trabalho), já reduzido.
pub(crate) fn screen(rect: Rect, max_width: u32, max_height: u32) -> Result<Bitmap, Error> {
    let _pixels = PhysicalPixels::enter();
    let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
    let canvas = Canvas::new(width, height)?;
    // SAFETY: o contexto da tela é pedido e devolvido aqui; a cópia fica dentro do bitmap do
    // `canvas`, que tem exatamente `width` x `height`.
    let copied = unsafe {
        let desktop = GetDC(None);
        let copied = BitBlt(
            canvas.dc,
            0,
            0,
            width,
            height,
            Some(desktop),
            rect.left,
            rect.top,
            SRCCOPY | CAPTUREBLT,
        );
        ReleaseDC(None, desktop);
        copied
    };
    copied?;
    Ok(shrink(
        canvas.pixels(),
        canvas.stride(),
        canvas.whole(),
        max_width,
        max_height,
    ))
}

/// O retângulo que a pessoa vê (sem as bordas invisíveis), em pixels físicos.
fn visible_frame(hwnd: HWND) -> Option<Rect> {
    let mut frame = RECT::default();
    // SAFETY: `frame` é local e o tamanho informado é o dele.
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut frame).cast(),
            size_of::<RECT>() as u32,
        )
    }
    .ok()
    .map(|()| frame.into())
}

/// Bitmap de 32 bits em memória onde o GDI desenha, com os pixels acessíveis.
struct Canvas {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *const u8,
    width: usize,
    height: usize,
}

impl Canvas {
    fn new(width: i32, height: i32) -> Result<Self, Error> {
        if width <= 0 || height <= 0 {
            return Err(Error::Blank);
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Altura negativa: linhas de cima para baixo.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        // SAFETY: `info` descreve um bitmap de 32 bits sem paleta; o Windows aloca os pixels e
        // devolve o endereço em `bits`. O que for criado aqui é liberado em `drop` (ou logo
        // abaixo, se a segunda criação falhar).
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return Err(Error::Os(E_FAIL));
            }
            let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
            {
                Ok(bitmap) if !bits.is_null() => bitmap,
                _ => {
                    let _ = DeleteDC(dc);
                    return Err(Error::Os(E_FAIL));
                }
            };
            let previous = SelectObject(dc, bitmap.into());
            Ok(Self {
                dc,
                bitmap,
                previous,
                bits: bits.cast(),
                width: width as usize,
                height: height as usize,
            })
        }
    }

    fn stride(&self) -> usize {
        self.width * 4
    }

    fn whole(&self) -> Area {
        Area {
            x: 0,
            y: 0,
            width: self.width,
            height: self.height,
        }
    }

    /// `inner` (coordenadas da tela) recortado para dentro deste bitmap, que começa em `outer`.
    fn area_of(&self, inner: &Rect, outer: &Rect) -> Area {
        let left = (inner.left - outer.left).clamp(0, self.width as i32 - 1) as usize;
        let top = (inner.top - outer.top).clamp(0, self.height as i32 - 1) as usize;
        let right = (inner.right - outer.left).clamp(left as i32 + 1, self.width as i32) as usize;
        let bottom = (inner.bottom - outer.top).clamp(top as i32 + 1, self.height as i32) as usize;
        Area {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        }
    }

    fn pixels(&self) -> &[u8] {
        // SAFETY: `bits` aponta para `width * height * 4` bytes do bitmap, que vive enquanto
        // `self` viver; o GdiFlush garante que os desenhos pendentes já estão lá.
        unsafe {
            let _ = GdiFlush();
            std::slice::from_raw_parts(self.bits, self.width * self.height * 4)
        }
    }
}

impl Drop for Canvas {
    fn drop(&mut self) {
        // SAFETY: desfaz, na ordem inversa, o que `new` criou; nada disso é usado depois.
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

/// `E_FAIL`: o GDI não diz por que não conseguiu criar o bitmap.
const E_FAIL: i32 = 0x8000_4005_u32 as i32;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_frame_is_cropped_inside_the_window_bitmap() {
        let canvas = Canvas::new(816, 608).unwrap();
        // Janela comum: 8 pixels invisíveis à esquerda, à direita e embaixo.
        let outer = Rect {
            left: 92,
            top: 100,
            right: 908,
            bottom: 708,
        };
        let inner = Rect {
            left: 100,
            top: 100,
            right: 900,
            bottom: 700,
        };
        assert_eq!(
            canvas.area_of(&inner, &outer),
            Area {
                x: 8,
                y: 0,
                width: 800,
                height: 600
            }
        );
        // Um retângulo maluco nunca sai do bitmap.
        let wild = Rect {
            left: -5000,
            top: -5000,
            right: 5000,
            bottom: 5000,
        };
        assert_eq!(canvas.area_of(&wild, &outer), canvas.whole());
    }

    #[test]
    fn empty_sizes_are_refused() {
        assert!(matches!(Canvas::new(0, 10), Err(Error::Blank)));
        assert!(matches!(Canvas::new(10, -1), Err(Error::Blank)));
    }

    #[test]
    fn new_canvas_is_black_and_readable() {
        let canvas = Canvas::new(8, 4).unwrap();
        assert_eq!(canvas.pixels().len(), 8 * 4 * 4);
        assert!(canvas.pixels().iter().all(|&byte| byte == 0));
    }
}
