//! O que o Nimbo sabe sobre jogos: a tabela de executáveis conhecidos e a regra "isto parece um
//! jogo". Cópia de `desktop/main.cjs` (`GAMES`, `gameName`, `exeOf`, `isGameLike`); enquanto os
//! dois aplicativos existirem, o que mudar lá muda aqui.

use crate::WindowInfo;

/// Executável (minúsculo, sem `.exe`) e o nome mostrado no seletor. Janelas e processos destes
/// jogos entram no seletor mesmo que caiam nos filtros ou que nenhuma janela apareça.
/// main.cjs:167-191.
const GAMES: &[(&str, &str)] = &[
    ("valorant-win64-shipping", "VALORANT"),
    ("valorant", "VALORANT"),
    ("cs2", "Counter-Strike 2"),
    ("csgo", "Counter-Strike"),
    ("league of legends", "League of Legends"),
    ("fortniteclient-win64-shipping", "Fortnite"),
    ("r5apex", "Apex Legends"),
    ("r5apex_dx12", "Apex Legends"),
    ("gta5", "GTA V"),
    ("gtav", "GTA V"),
    ("rocketleague", "Rocket League"),
    ("overwatch", "Overwatch 2"),
    ("dota2", "Dota 2"),
    ("eldenring", "Elden Ring"),
    ("javaw", "Minecraft"),
    ("robloxplayerbeta", "Roblox"),
    ("cod", "Call of Duty"),
    ("tslgame", "PUBG"),
    ("destiny2", "Destiny 2"),
    ("rainbowsix", "Rainbow Six Siege"),
    ("marvel-win64-shipping", "Marvel Rivals"),
    ("deadlock", "Deadlock"),
    ("project8", "Deadlock"),
];

/// Nome do jogo para um executável (`cs2.exe`) ou nome de processo (`cs2`), em qualquer caixa.
/// main.cjs:192.
pub fn game_name(exe: &str) -> Option<&'static str> {
    let exe = exe.to_lowercase();
    let stem = exe.strip_suffix(".exe").unwrap_or(&exe);
    GAMES
        .iter()
        .find(|(known, _)| *known == stem)
        .map(|(_, name)| *name)
}

/// O nome do arquivo no fim de um caminho (`C:\Jogos\cs2.exe` vira `cs2.exe`). main.cjs:193.
pub fn exe_of(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// A janela parece um jogo: executável conhecido, janela da Unreal Engine, ou cobre o monitor
/// inteiro. Tela cheia só conta se a janela estiver de fato à vista: o Windows tem janelas de
/// sistema escondidas do tamanho da tela. main.cjs:197-200.
pub fn is_game_like(window: &WindowInfo) -> bool {
    game_name(exe_of(&window.path)).is_some()
        || window.class.to_lowercase().contains("unrealwindow")
        || (window.fullscreen && window.visible && !window.cloaked && !window.tool)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window() -> WindowInfo {
        WindowInfo {
            hwnd: 1,
            pid: 1,
            visible: true,
            owned: false,
            tool: false,
            cloaked: false,
            minimized: false,
            fullscreen: false,
            class: "Notepad".into(),
            title: "Sem título".into(),
            path: r"C:\Windows\notepad.exe".into(),
        }
    }

    #[test]
    fn known_executables_have_a_display_name() {
        assert_eq!(game_name("cs2.exe"), Some("Counter-Strike 2"));
        assert_eq!(game_name("CS2.EXE"), Some("Counter-Strike 2"));
        // Nome de processo vem sem extensão.
        assert_eq!(game_name("VALORANT-Win64-Shipping"), Some("VALORANT"));
        assert_eq!(
            game_name("League of Legends.exe"),
            Some("League of Legends")
        );
        assert_eq!(game_name("notepad.exe"), None);
        assert_eq!(game_name(""), None);
        // Só o nome inteiro vale: `cs2_launcher` não é o jogo.
        assert_eq!(game_name("cs2_launcher.exe"), None);
    }

    #[test]
    fn file_name_is_the_last_part_of_the_path() {
        assert_eq!(exe_of(r"C:\Jogos\CS2\cs2.exe"), "cs2.exe");
        assert_eq!(exe_of("C:/Jogos/cs2.exe"), "cs2.exe");
        assert_eq!(exe_of("cs2.exe"), "cs2.exe");
        assert_eq!(exe_of(""), "");
    }

    #[test]
    fn game_like_by_executable_class_or_fullscreen() {
        assert!(!is_game_like(&window()));
        assert!(is_game_like(&WindowInfo {
            path: r"D:\Steam\cs2.exe".into(),
            ..window()
        }));
        // Executável conhecido vale mesmo com a janela escondida pelo anticheat.
        assert!(is_game_like(&WindowInfo {
            path: r"D:\Riot\VALORANT-Win64-Shipping.exe".into(),
            visible: false,
            cloaked: true,
            ..window()
        }));
        assert!(is_game_like(&WindowInfo {
            class: "UnrealWindow".into(),
            ..window()
        }));
        assert!(is_game_like(&WindowInfo {
            fullscreen: true,
            ..window()
        }));
    }

    #[test]
    fn hidden_fullscreen_system_windows_are_not_games() {
        for hidden in [
            WindowInfo {
                visible: false,
                ..window()
            },
            WindowInfo {
                cloaked: true,
                ..window()
            },
            WindowInfo {
                tool: true,
                ..window()
            },
        ] {
            assert!(!is_game_like(&WindowInfo {
                fullscreen: true,
                ..hidden
            }));
        }
    }
}
