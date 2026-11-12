//! A lista do seletor "o que transmitir": telas primeiro, depois as janelas que fazem sentido
//! oferecer, na ordem em que o aplicativo em Electron mostra.
//!
//! No Electron a lista tem duas origens, e as regras daqui são as duas juntas:
//! 1. `desktopCapturer.getSources` (main.cjs:374-388): a lista do Chromium, que só traz janelas
//!    prontas para capturar (à vista, com título, fora da bandeja).
//! 2. `missingSources` (main.cjs:223-268): o que o Chromium deixa de fora e o Nimbo quer mesmo
//!    assim (janelas minimizadas, sem título, jogos escondidos pelo anticheat e jogos sem janela).

use std::collections::HashSet;

use windows::Win32::UI::WindowsAndMessaging::{GWL_EXSTYLE, GetWindowLongW, WS_EX_APPWINDOW};

use crate::games::{exe_of, game_name, is_game_like};
use crate::window::handle;
use crate::{
    Hwnd, MonitorInfo, ProcessInfo, WindowInfo, list_monitors, list_processes, list_windows,
    process,
};

/// O tipo de um item do seletor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    /// Um monitor inteiro (aba "Telas").
    Screen,
    /// Uma janela (aba "Aplicativos").
    Window,
    /// Um jogo rodando sem nenhuma janela na lista: transmite a tela dele. Fica na aba dos
    /// aplicativos (no Electron é `type: 'window'` com `process: true`).
    Game,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::Screen => "screen",
            SourceKind::Window => "window",
            SourceKind::Game => "game",
        }
    }
}

/// Um item do seletor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickerSource {
    /// `screen:<índice>`, `window:<hwnd>` ou `game:<pid>`.
    pub id: String,
    pub kind: SourceKind,
    /// O nome mostrado: título da janela, nome do jogo, nome do executável ou "Tela N".
    pub title: String,
    /// Nome do arquivo do executável (`chrome.exe`); vazio em telas e em processos protegidos.
    pub exe: String,
    /// Caminho do executável, para buscar o ícone; vazio quando o Windows não deixa consultar.
    pub path: String,
    /// A janela (0 em telas e em jogos sem janela).
    pub hwnd: Hwnd,
    /// O processo (0 em telas).
    pub pid: u32,
    /// O índice do monitor (0 no que não é tela).
    pub monitor: usize,
    /// Janela minimizada: não tem prévia e volta à tela ao ser escolhida.
    pub minimized: bool,
    /// Janela cobrindo o monitor inteiro: a live transmite o monitor dela.
    pub fullscreen: bool,
    /// Parece um jogo ([`crate::is_game_like`]); jogos sem janela sempre são.
    pub game: bool,
}

/// Tudo o que dá para transmitir agora. As janelas deste processo ficam de fora; `exclude_pids`
/// tira também as de outros processos do próprio aplicativo (os do WebView2, por exemplo).
pub fn picker_sources(exclude_pids: &[u32]) -> Vec<PickerSource> {
    let mut own = exclude_pids.to_vec();
    own.push(std::process::id());
    arrange(
        &list_monitors(),
        &list_windows(),
        &list_processes(),
        &own,
        &|window| has_taskbar_style(window.hwnd),
        &process::path,
    )
}

/// A janela pede para aparecer na barra de tarefas mesmo tendo dona (`WS_EX_APPWINDOW`).
fn has_taskbar_style(hwnd: Hwnd) -> bool {
    // SAFETY: consulta simples sobre um HWND; janela que já fechou devolve zero.
    let style = unsafe { GetWindowLongW(handle(hwnd), GWL_EXSTYLE) } as u32;
    style & WS_EX_APPWINDOW.0 != 0
}

/// As regras, separadas das chamadas ao Windows para poderem ser testadas com listas inventadas.
fn arrange(
    monitors: &[MonitorInfo],
    windows: &[WindowInfo],
    processes: &[ProcessInfo],
    own: &[u32],
    in_taskbar: &dyn Fn(&WindowInfo) -> bool,
    path_of: &dyn Fn(u32) -> String,
) -> Vec<PickerSource> {
    // main.cjs:227 e 383: nada do próprio Nimbo. A área de trabalho não é um aplicativo (o
    // Chromium a pula pela classe; aqui vale para a lista inteira).
    let theirs = windows
        .iter()
        .filter(|w| !own.contains(&w.pid) && !is_desktop(w));
    // 1. O que o Chromium lista (main.cjs:374-388), na ordem do Windows: da frente para trás.
    let (ready, rest): (Vec<_>, Vec<_>) = theirs.partition(|w| is_ready(w, in_taskbar(w)));
    // 2. main.cjs:228: as demais janelas de aplicativo (minimizadas, sem título).
    let (apps, hidden): (Vec<_>, Vec<_>) = rest.into_iter().partition(|w| is_app_window(w));
    // 3. main.cjs:229-240: um jogo pode ficar escondido ou "auxiliar" para o Windows. Entra a
    // melhor janela de cada processo de jogo que ainda não tem janela na lista.
    let mut shown: HashSet<u32> = ready.iter().chain(&apps).map(|w| w.pid).collect();
    let mut games: Vec<&WindowInfo> = Vec::new();
    for window in hidden {
        if shown.contains(&window.pid) || !is_game_like(window) || is_keyboard_helper(window) {
            continue;
        }
        match games.iter_mut().find(|best| best.pid == window.pid) {
            Some(best) if score(window) > score(best) => *best = window,
            Some(_) => {}
            None => games.push(window),
        }
    }
    shown.extend(games.iter().map(|w| w.pid));
    // 4. main.cjs:241-258: jogo rodando sem nenhuma janela na lista (o anticheat pode esconder
    // até a janela) entra pelo processo. Um item por jogo; o "-Shipping" (o jogo de fato) ganha.
    let mut running: Vec<(&'static str, &ProcessInfo)> = Vec::new();
    for process in processes {
        let Some(name) = game_name(&process.name) else {
            continue;
        };
        if shown.contains(&process.pid) || own.contains(&process.pid) {
            continue;
        }
        match running.iter_mut().find(|(known, _)| *known == name) {
            Some(entry) if process.name.to_lowercase().contains("shipping") => entry.1 = process,
            Some(_) => {}
            None => running.push((name, process)),
        }
    }

    let screens = monitors.iter().map(|m| screen(m, monitors.len()));
    let windows = ready.iter().chain(&apps).chain(&games).map(|w| window(w));
    let processes = running
        .iter()
        .map(|(name, process)| game_process(name, process, path_of(process.pid)));
    screens.chain(windows).chain(processes).collect()
}

/// A lista de janelas do Chromium (WebRTC, `GetWindowListHandler` e o capturador por Windows
/// Graphics Capture): à vista, não minimizada, não escondida pelo Windows, com título, fora da
/// bandeja e, se tiver dona, só com o estilo de barra de tarefas.
fn is_ready(window: &WindowInfo, in_taskbar: bool) -> bool {
    window.visible
        && !window.minimized
        && !window.cloaked
        && !window.tool
        && !window.title.is_empty()
        && (!window.owned || in_taskbar)
}

/// main.cjs:202 (`isAppWindow`): visível, sem dona, que não é auxiliar nem está escondida.
fn is_app_window(window: &WindowInfo) -> bool {
    window.visible && !window.owned && !window.tool && !window.cloaked
}

/// A área de trabalho e o botão Iniciar antigo: classes que o Chromium pula.
fn is_desktop(window: &WindowInfo) -> bool {
    matches!(window.class.as_str(), "Progman" | "Button")
}

/// main.cjs:236: as janelas de teclado (IME) que todo processo com janela tem.
fn is_keyboard_helper(window: &WindowInfo) -> bool {
    matches!(window.class.as_str(), "IME" | "MSCTFIME UI")
}

/// main.cjs:233: entre as janelas de um jogo, a principal é a visível, sem dona, que não é
/// auxiliar; minimizada desempata.
fn score(window: &WindowInfo) -> u32 {
    u32::from(window.visible) * 4
        + u32::from(!window.owned) * 2
        + u32::from(!window.tool)
        + u32::from(window.minimized)
}

fn screen(monitor: &MonitorInfo, count: usize) -> PickerSource {
    PickerSource {
        id: format!("screen:{}", monitor.index),
        kind: SourceKind::Screen,
        // capture-picker.html:179: "Tela inteira" quando só há uma.
        title: if count > 1 {
            format!("Tela {}", monitor.index)
        } else {
            "Tela inteira".into()
        },
        exe: String::new(),
        path: String::new(),
        hwnd: 0,
        pid: 0,
        monitor: monitor.index,
        minimized: false,
        fullscreen: false,
        game: false,
    }
}

fn window(window: &WindowInfo) -> PickerSource {
    let exe = exe_of(&window.path);
    // main.cjs:264: título; sem título, o nome do jogo, o do executável ou "Janela sem título".
    let title = if !window.title.is_empty() {
        window.title.clone()
    } else if let Some(game) = game_name(exe) {
        game.into()
    } else if !stem(exe).is_empty() {
        stem(exe).into()
    } else {
        "Janela sem título".into()
    };
    PickerSource {
        id: format!("window:{}", window.hwnd),
        kind: SourceKind::Window,
        title,
        exe: exe.into(),
        path: window.path.clone(),
        hwnd: window.hwnd,
        pid: window.pid,
        monitor: 0,
        minimized: window.minimized,
        fullscreen: window.fullscreen,
        game: is_game_like(window),
    }
}

fn game_process(name: &str, process: &ProcessInfo, path: String) -> PickerSource {
    PickerSource {
        id: format!("game:{}", process.pid),
        kind: SourceKind::Game,
        title: name.into(),
        exe: exe_of(&path).into(),
        path,
        hwnd: 0,
        pid: process.pid,
        monitor: 0,
        minimized: false,
        fullscreen: false,
        game: true,
    }
}

/// O nome do executável sem o `.exe` do fim (em qualquer caixa).
fn stem(exe: &str) -> &str {
    let cut = exe.len().saturating_sub(4);
    match exe.get(cut..) {
        Some(extension) if extension.eq_ignore_ascii_case(".exe") => &exe[..cut],
        _ => exe,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Rect;

    const OWN: u32 = 999;

    fn app(hwnd: Hwnd, pid: u32, title: &str, exe: &str) -> WindowInfo {
        WindowInfo {
            hwnd,
            pid,
            visible: true,
            owned: false,
            tool: false,
            cloaked: false,
            minimized: false,
            fullscreen: false,
            class: "Janela".into(),
            title: title.into(),
            path: format!(r"C:\Apps\{exe}"),
        }
    }

    fn monitor(index: usize) -> MonitorInfo {
        MonitorInfo {
            index,
            device: format!(r"\\.\DISPLAY{index}"),
            name: String::new(),
            rect: Rect {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080,
            },
            primary: index == 1,
        }
    }

    fn process(pid: u32, name: &str) -> ProcessInfo {
        ProcessInfo {
            pid,
            name: name.into(),
        }
    }

    fn sources(
        monitors: &[MonitorInfo],
        windows: &[WindowInfo],
        processes: &[ProcessInfo],
    ) -> Vec<PickerSource> {
        arrange(monitors, windows, processes, &[OWN], &|_| false, &|pid| {
            format!(r"C:\Jogos\{pid}.exe")
        })
    }

    fn ids(sources: &[PickerSource]) -> Vec<&str> {
        sources.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn screens_come_first_and_are_named_like_the_picker() {
        let one = sources(&[monitor(1)], &[], &[]);
        assert_eq!(ids(&one), ["screen:1"]);
        assert_eq!(one[0].title, "Tela inteira");
        assert_eq!((one[0].kind, one[0].monitor), (SourceKind::Screen, 1));

        let two = sources(
            &[monitor(1), monitor(2)],
            &[app(10, 1, "Bloco", "notepad.exe")],
            &[],
        );
        assert_eq!(ids(&two), ["screen:1", "screen:2", "window:10"]);
        assert_eq!(two[0].title, "Tela 1");
        assert_eq!(two[1].title, "Tela 2");
    }

    #[test]
    fn ready_windows_keep_the_system_order_and_the_rest_follows() {
        let windows = [
            app(10, 1, "Na frente", "a.exe"),
            WindowInfo {
                minimized: true,
                ..app(11, 2, "Minimizada", "b.exe")
            },
            app(12, 3, "Atrás", "c.exe"),
            WindowInfo {
                title: String::new(),
                ..app(13, 4, "", "sem-titulo.exe")
            },
        ];
        let listed = sources(&[], &windows, &[]);
        // Prontas primeiro (10, 12); depois a minimizada e a sem título, na ordem do Windows.
        assert_eq!(
            ids(&listed),
            ["window:10", "window:12", "window:11", "window:13"]
        );
        assert!(listed[2].minimized);
        // Sem título, vale o nome do executável.
        assert_eq!(listed[3].title, "sem-titulo");
        assert_eq!(listed[3].exe, "sem-titulo.exe");
        assert_eq!(listed[0].path, r"C:\Apps\a.exe");
    }

    #[test]
    fn helper_hidden_and_own_windows_are_left_out() {
        let windows = [
            app(1, OWN, "Nimbo", "nimbo.exe"),
            WindowInfo {
                tool: true,
                ..app(2, 2, "Paleta", "a.exe")
            },
            WindowInfo {
                cloaked: true,
                ..app(3, 3, "Outra área de trabalho", "b.exe")
            },
            WindowInfo {
                visible: false,
                ..app(4, 4, "Invisível", "c.exe")
            },
            WindowInfo {
                owned: true,
                ..app(5, 5, "Diálogo", "d.exe")
            },
            WindowInfo {
                class: "Progman".into(),
                ..app(6, 6, "Program Manager", "explorer.exe")
            },
            app(7, 7, "Fica", "e.exe"),
        ];
        assert_eq!(ids(&sources(&[], &windows, &[])), ["window:7"]);
    }

    #[test]
    fn owned_windows_enter_only_with_the_taskbar_style() {
        let dialog = WindowInfo {
            owned: true,
            ..app(5, 5, "Janela com dona", "d.exe")
        };
        let listed = arrange(
            &[],
            std::slice::from_ref(&dialog),
            &[],
            &[],
            &|_| true,
            &|_| String::new(),
        );
        assert_eq!(ids(&listed), ["window:5"]);
        // Minimizada, cai na regra das janelas de aplicativo, que não aceita janela com dona.
        let minimized = WindowInfo {
            minimized: true,
            ..dialog
        };
        let listed = arrange(&[], &[minimized], &[], &[], &|_| true, &|_| String::new());
        assert!(listed.is_empty());
    }

    #[test]
    fn hidden_game_windows_enter_once_per_process() {
        let windows = [
            app(10, 1, "Navegador", "chrome.exe"),
            // Jogo escondido pelo anticheat: três janelas do mesmo processo.
            WindowInfo {
                class: "IME".into(),
                visible: false,
                ..app(20, 50, "Default IME", "VALORANT-Win64-Shipping.exe")
            },
            WindowInfo {
                tool: true,
                visible: false,
                ..app(21, 50, "auxiliar", "VALORANT-Win64-Shipping.exe")
            },
            WindowInfo {
                cloaked: true,
                ..app(22, 50, "VALORANT", "VALORANT-Win64-Shipping.exe")
            },
            // Janela escondida de um aplicativo que já está na lista não entra de novo.
            WindowInfo {
                cloaked: true,
                fullscreen: true,
                class: "UnrealWindow".into(),
                ..app(11, 1, "Escondida", "chrome.exe")
            },
        ];
        let listed = sources(&[], &windows, &[]);
        assert_eq!(ids(&listed), ["window:10", "window:22"]);
        assert!(listed[1].game);
        assert!(!listed[0].game);
    }

    #[test]
    fn untitled_game_window_gets_the_game_name() {
        let windows = [WindowInfo {
            title: String::new(),
            ..app(30, 60, "", "cs2.exe")
        }];
        let listed = sources(&[], &windows, &[]);
        assert_eq!(listed[0].title, "Counter-Strike 2");
        assert!(listed[0].game);
    }

    #[test]
    fn fullscreen_window_is_flagged_as_game_like() {
        let windows = [WindowInfo {
            fullscreen: true,
            ..app(40, 70, "Jogo desconhecido", "indie.exe")
        }];
        let listed = sources(&[], &windows, &[]);
        assert!(listed[0].fullscreen && listed[0].game);
    }

    #[test]
    fn games_without_any_window_enter_by_process() {
        let windows = [app(10, 100, "Counter-Strike 2", "cs2.exe")];
        let processes = [
            process(100, "cs2"),
            process(200, "VALORANT"),
            process(201, "VALORANT-Win64-Shipping"),
            process(300, "notepad"),
            process(OWN, "javaw"),
        ];
        let listed = sources(&[monitor(1)], &windows, &processes);
        // O CS2 já tem janela; do Valorant entra só o "-Shipping"; o javaw é do próprio Nimbo.
        assert_eq!(ids(&listed), ["screen:1", "window:10", "game:201"]);
        let game = &listed[2];
        assert_eq!(game.kind, SourceKind::Game);
        assert_eq!(game.title, "VALORANT");
        assert_eq!((game.hwnd, game.pid), (0, 201));
        assert_eq!(game.exe, "201.exe");
        assert!(game.game && !game.minimized);
    }

    #[test]
    fn live_list_has_screens_then_windows_and_never_this_process() {
        let listed = picker_sources(&[]);
        let first_window = listed
            .iter()
            .position(|s| s.kind != SourceKind::Screen)
            .unwrap_or(listed.len());
        assert!(
            listed[first_window..]
                .iter()
                .all(|s| s.kind != SourceKind::Screen)
        );
        assert!(listed.iter().all(|s| s.pid != std::process::id()));
        assert!(listed.iter().all(|s| !s.title.is_empty()));
    }
}
