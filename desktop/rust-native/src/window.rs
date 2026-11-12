//! Janelas de primeiro nível: a lista que o seletor usa, o retângulo de uma janela e do monitor
//! dela (jogo em tela cheia) e trazer uma janela minimizada de volta.

use std::ffi::c_void;

use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GW_OWNER, GWL_EXSTYLE, GetClassNameW, GetForegroundWindow, GetWindow,
    GetWindowLongW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, SW_RESTORE, SetForegroundWindow, ShowWindow, WS_EX_TOOLWINDOW,
};
use windows::core::BOOL;

use crate::{Error, Hwnd, process, wide};

/// Uma janela de primeiro nível, com os motivos que normalmente a tirariam de um seletor. Quem
/// decide é quem chama: jogos caem nesses filtros e entram mesmo assim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub hwnd: Hwnd,
    pub pid: u32,
    pub visible: bool,
    /// Tem janela dona (diálogo, janela auxiliar de outra).
    pub owned: bool,
    /// Janela de ferramenta (`WS_EX_TOOLWINDOW`): não aparece na barra de tarefas.
    pub tool: bool,
    /// Escondida pelo próprio Windows (outra área de trabalho virtual, app suspenso).
    pub cloaked: bool,
    pub minimized: bool,
    /// Cobre o monitor inteiro. Janelas escondidas do sistema também cobrem: confira `visible`.
    pub fullscreen: bool,
    pub class: String,
    pub title: String,
    /// Caminho do executável; vazio quando o Windows não deixa consultar (processo protegido).
    pub path: String,
}

/// Retângulo em pixels físicos, como o Windows devolve (direita e base ficam fora).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    /// Este retângulo cobre o outro por inteiro (janela em tela cheia cobre o monitor).
    pub fn covers(&self, other: &Rect) -> bool {
        self.left <= other.left
            && self.top <= other.top
            && self.right >= other.right
            && self.bottom >= other.bottom
    }
}

impl From<RECT> for Rect {
    fn from(rect: RECT) -> Self {
        Rect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }
}

/// Onde a janela está e em que monitor, para saber se é um jogo em tela cheia.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowGeometry {
    pub fullscreen: bool,
    pub minimized: bool,
    pub window: Rect,
    pub monitor: Rect,
}

/// Todas as janelas de primeiro nível com título (ou visíveis sem título), na ordem do Windows
/// (da frente para trás), inclusive minimizadas, escondidas e de processos protegidos.
pub fn list_windows() -> Vec<WindowInfo> {
    let _pixels = PhysicalPixels::enter();
    let mut handles: Vec<HWND> = Vec::new();
    // SAFETY: `collect` só usa o ponteiro durante esta chamada, e `handles` vive até ela voltar.
    // Um erro aqui só significa lista parcial; o que já foi coletado ainda vale.
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(&raw mut handles as isize)) };
    handles.into_iter().filter_map(describe).collect()
}

unsafe extern "system" fn collect(hwnd: HWND, handles: LPARAM) -> BOOL {
    // SAFETY: `handles` é o endereço do Vec de `list_windows`, vivo e sem outro acesso enquanto
    // o EnumWindows roda (ele chama de volta na mesma thread).
    let handles = unsafe { &mut *(handles.0 as *mut Vec<HWND>) };
    handles.push(hwnd);
    true.into()
}

fn describe(hwnd: HWND) -> Option<WindowInfo> {
    let mut title = [0u16; 512];
    let mut class = [0u16; 256];
    let mut cloaked = 0u32;
    // SAFETY: consultas sobre um HWND; se a janela já fechou, elas só devolvem vazio/falso. Os
    // buffers são locais e o tamanho vai junto; `cloaked` tem os 4 bytes informados.
    let (visible, is_cloaked, minimized, owned, tool) = unsafe {
        let titled = GetWindowTextW(hwnd, &mut title) != 0;
        let visible = IsWindowVisible(hwnd).as_bool();
        // Sem título só entra se estiver visível (o Nimbo mostra o nome do executável).
        if !titled && !visible {
            return None;
        }
        GetClassNameW(hwnd, &mut class);
        let is_cloaked =
            DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&raw mut cloaked).cast(), 4).is_ok();
        (
            visible,
            is_cloaked && cloaked != 0,
            IsIconic(hwnd).as_bool(),
            GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.0.is_null()),
            GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0,
        )
    };
    let pid = owner_pid(hwnd);
    Some(WindowInfo {
        hwnd: hwnd.0 as Hwnd,
        pid,
        visible,
        owned,
        tool,
        cloaked: is_cloaked,
        minimized,
        // Minimizada, a janela fica num retângulo fora da tela que não diz nada.
        fullscreen: !minimized
            && rects(hwnd).is_ok_and(|(window, monitor)| window.covers(&monitor)),
        class: wide(&class),
        title: wide(&title),
        path: process::path(pid),
    })
}

/// Retângulo da janela e do monitor dela, e se a janela cobre o monitor inteiro.
pub fn window_info(hwnd: Hwnd) -> Result<WindowGeometry, Error> {
    let _pixels = PhysicalPixels::enter();
    let hwnd = handle(hwnd);
    let (window, monitor) = rects(hwnd)?;
    // SAFETY: consulta simples sobre um HWND; janela inexistente devolve falso.
    let minimized = unsafe { IsIconic(hwnd) }.as_bool();
    Ok(WindowGeometry {
        fullscreen: !minimized && window.covers(&monitor),
        minimized,
        window,
        monitor,
    })
}

/// Traz a janela de volta e para a frente (o jogo minimizado volta à tela ao ser escolhido).
/// O Windows pode recusar a troca de foco; aí a janela só pisca na barra de tarefas.
pub fn restore(hwnd: Hwnd) {
    let hwnd = handle(hwnd);
    // SAFETY: pedidos sobre um HWND; se a janela não existe mais, o Windows só recusa.
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = SetForegroundWindow(hwnd);
    }
}

/// Processo dono da janela; 0 se a janela não existe.
pub(crate) fn owner_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    // SAFETY: `pid` é uma variável local válida durante a chamada.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// Uma janela desse processo está na frente e não está minimizada.
pub(crate) fn is_foreground(pid: u32) -> bool {
    // SAFETY: consultas sem ponteiros; o HWND pode até já ter fechado, e aí o resultado é falso.
    unsafe {
        let foreground = GetForegroundWindow();
        !foreground.0.is_null() && owner_pid(foreground) == pid && !IsIconic(foreground).as_bool()
    }
}

pub(crate) fn handle(hwnd: Hwnd) -> HWND {
    HWND(hwnd as *mut c_void)
}

fn rects(hwnd: HWND) -> Result<(Rect, Rect), Error> {
    let mut window = RECT::default();
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `window` e `info` são locais, e `cbSize` diz o tamanho certo da estrutura.
    unsafe {
        GetWindowRect(hwnd, &mut window).map_err(|_| Error::WindowNotFound)?;
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err(Error::MonitorNotFound);
        }
    }
    Ok((window.into(), info.rcMonitor.into()))
}

/// Enquanto existir, esta thread enxerga janelas e monitores em pixels físicos. Sem isso, num
/// processo que não declara DPI, o Windows devolve medidas escaladas e a conta de tela cheia erra.
/// É por thread (e desfeito no fim) para não mudar o processo de quem usa a biblioteca.
struct PhysicalPixels(DPI_AWARENESS_CONTEXT);

impl PhysicalPixels {
    fn enter() -> Self {
        // SAFETY: só troca o contexto de DPI desta thread; devolve o anterior (nulo se falhar).
        Self(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) })
    }
}

impl Drop for PhysicalPixels {
    fn drop(&mut self) {
        if !self.0.0.is_null() {
            // SAFETY: devolve à thread o contexto que ela tinha antes de `enter`.
            unsafe { SetThreadDpiAwarenessContext(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: Rect = Rect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };

    #[test]
    fn fullscreen_means_covering_the_whole_monitor() {
        assert!(MONITOR.covers(&MONITOR));
        // Janela maximizada passa 8 pixels de cada lado e também conta, como no C#.
        let maximized = Rect {
            left: -8,
            top: -8,
            right: 1928,
            bottom: 1088,
        };
        assert!(maximized.covers(&MONITOR));
        let windowed = Rect {
            left: 100,
            top: 100,
            right: 1380,
            bottom: 820,
        };
        assert!(!windowed.covers(&MONITOR));
        // Falta a barra de tarefas: não é tela cheia.
        let work_area = Rect {
            bottom: 1032,
            ..MONITOR
        };
        assert!(!work_area.covers(&MONITOR));
    }

    #[test]
    fn listed_windows_have_a_title_or_are_visible() {
        for window in list_windows() {
            assert!(!window.title.is_empty() || window.visible, "{window:?}");
            assert_ne!(window.hwnd, 0);
        }
    }

    #[test]
    fn missing_window_is_an_error() {
        assert_eq!(window_info(0), Err(Error::WindowNotFound));
    }
}
