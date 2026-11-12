//! O ícone de um aplicativo, como a barra de tarefas mostra: o da janela; se ela não tiver, o do
//! aplicativo da loja a que ela pertence; por fim, o do executável.

use std::ffi::c_void;

use windows::Win32::Foundation::{HWND, LPARAM, PROPERTYKEY, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::DeleteObject;
use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GCLP_HICON, GCLP_HICONSM, GetClassLongPtrW, HICON, ICON_BIG, ICON_SMALL, ICON_SMALL2, IsWindow,
    SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_GETICON,
};
use windows::core::{GUID, HSTRING};

use crate::imaging::{self, Com, IconImage, MAX_ICON};
use crate::window::{handle, owner_pid};
use crate::{Error, Hwnd, process};

/// De onde tirar o ícone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconSource<'a> {
    /// O ícone que a barra de tarefas mostra para a janela.
    Window(Hwnd),
    /// O ícone do executável nesse caminho (jogo que entrou no seletor sem janela).
    Exe(&'a str),
}

/// Até este tamanho o ícone pequeno da janela (16 pixels) serve melhor que o grande reduzido.
const SMALL: u32 = 20;
/// Quanto esperar a janela responder qual é o ícone dela; janela travada não segura o seletor.
const ANSWER_MS: u32 = 100;
/// `System.AppUserModel.ID`: a que aplicativo a janela pertence, para a barra de tarefas.
const APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};

/// O ícone em PNG de `size` x `size` pixels (de 1 a 256), com transparência.
pub fn app_icon(source: IconSource<'_>, size: u32) -> Result<Vec<u8>, Error> {
    let _com = Com::enter();
    let hwnd = match source {
        IconSource::Exe(path) => return shell_icon(path, size),
        IconSource::Window(hwnd) => handle(hwnd),
    };
    // SAFETY: consulta simples sobre um HWND.
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err(Error::WindowNotFound);
    }
    // O ícone da janela pertence a ela: não é destruído aqui. Se ele sumir no meio do caminho
    // (a janela fechou), segue para os próximos.
    if let Some(png) =
        window_icon(hwnd, size).and_then(|icon| imaging::icon_png(IconImage::Icon(icon), size).ok())
    {
        return Ok(png);
    }
    // Aplicativo da loja (Calculadora, Configurações): a janela é de um processo genérico do
    // Windows, sem ícone; o ícone certo é o do aplicativo registrado.
    if let Some(png) =
        app_id(hwnd).and_then(|id| shell_icon(&format!(r"shell:AppsFolder\{id}"), size).ok())
    {
        return Ok(png);
    }
    shell_icon(&process::path(owner_pid(hwnd)), size)
}

/// O ícone que a janela informa ou, se ela não informar, o da classe dela.
fn window_icon(hwnd: HWND, size: u32) -> Option<HICON> {
    let (kinds, classes) = if size > SMALL {
        (
            [ICON_BIG, ICON_SMALL2, ICON_SMALL],
            [GCLP_HICON, GCLP_HICONSM],
        )
    } else {
        (
            [ICON_SMALL2, ICON_SMALL, ICON_BIG],
            [GCLP_HICONSM, GCLP_HICON],
        )
    };
    let asked = kinds.into_iter().find_map(|kind| {
        let mut icon = 0usize;
        // SAFETY: mensagem de consulta com prazo; `icon` é local e recebe a resposta. Janela
        // travada ou fechada faz a chamada devolver zero.
        let answered = unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_GETICON,
                WPARAM(kind as usize),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                ANSWER_MS,
                Some(&mut icon),
            )
        };
        (answered.0 != 0 && icon != 0).then_some(icon)
    });
    asked
        .or_else(|| {
            classes
                .into_iter()
                // SAFETY: consulta sobre a classe de um HWND; sem ícone, devolve zero.
                .map(|index| unsafe { GetClassLongPtrW(hwnd, index) })
                .find(|&icon| icon != 0)
        })
        .map(|icon| HICON(icon as *mut c_void))
}

/// O identificador de aplicativo que a janela declara; `None` na maioria das janelas comuns.
fn app_id(hwnd: HWND) -> Option<String> {
    // SAFETY: a propriedade lida é local e é liberada antes de sair; o texto é copiado enquanto
    // ela ainda vale, e só é lido se o tipo disser que é um texto.
    unsafe {
        let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd).ok()?;
        let mut value = store.GetValue(&APP_USER_MODEL_ID).ok()?;
        let inner = &value.Anonymous.Anonymous;
        let id = (inner.vt == VT_LPWSTR && !inner.Anonymous.pwszVal.is_null())
            .then(|| inner.Anonymous.pwszVal.to_string().ok())
            .flatten();
        let _ = PropVariantClear(&mut value);
        id.filter(|id| !id.is_empty())
    }
}

/// O ícone que o Explorador mostra para um item (um executável ou um aplicativo registrado), no
/// tamanho pedido. Executável sem ícone próprio ganha o ícone genérico de programa, como na barra
/// de tarefas.
fn shell_icon(name: &str, size: u32) -> Result<Vec<u8>, Error> {
    if name.is_empty() {
        return Err(Error::NoIcon);
    }
    let side = size.clamp(1, MAX_ICON) as i32;
    // SAFETY: `name` vira uma string terminada em zero que vive até o fim da chamada. O bitmap
    // devolvido é nosso: é lido e destruído logo abaixo.
    let bitmap = unsafe {
        SHCreateItemFromParsingName::<_, _, IShellItemImageFactory>(&HSTRING::from(name), None)
            .and_then(|item| item.GetImage(SIZE { cx: side, cy: side }, SIIGBF_ICONONLY))
    }
    .map_err(|_| Error::NoIcon)?;
    let png = imaging::icon_png(IconImage::ShellBitmap(bitmap), size);
    // SAFETY: `bitmap` veio do GetImage acima e não é usado depois.
    let _ = unsafe { DeleteObject(bitmap.into()) };
    png
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

    #[test]
    fn executable_icon_is_a_png_of_the_requested_size() {
        let explorer = format!(
            r"{}\explorer.exe",
            std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())
        );
        for size in [16u32, 32, 48] {
            let png = app_icon(IconSource::Exe(&explorer), size).unwrap();
            assert_eq!(png[..8], *PNG_SIGNATURE);
            // Largura e altura no cabeçalho do PNG (IHDR), em big-endian.
            assert_eq!(png[16..20], size.to_be_bytes());
            assert_eq!(png[20..24], size.to_be_bytes());
            // Tipo de cor 6: com transparência.
            assert_eq!(png[25], 6);
        }
    }

    #[test]
    fn missing_sources_are_clear_errors() {
        assert_eq!(
            app_icon(IconSource::Window(0), 32),
            Err(Error::WindowNotFound)
        );
        assert_eq!(app_icon(IconSource::Exe(""), 32), Err(Error::NoIcon));
        assert_eq!(
            app_icon(IconSource::Exe(r"C:\nao\existe\jogo.exe"), 32),
            Err(Error::NoIcon)
        );
    }
}
