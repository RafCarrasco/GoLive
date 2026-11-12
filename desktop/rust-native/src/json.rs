//! JSON escrito à mão, byte a byte igual ao do C#: o Electron lê uma linha por item, e a
//! comparação entre os dois programas é por texto.

use crate::{MonitorInfo, PickerSource, ProcessInfo, Rect, WindowGeometry, WindowInfo};

/// Mesmo escape do `Json()` do C#: só aspas, barra invertida e caracteres de controle.
pub(crate) fn string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl WindowInfo {
    /// Uma linha do modo `list` (sem a quebra de linha).
    pub fn to_json(&self) -> String {
        format!(
            "{{\"hwnd\":\"{}\",\"pid\":{},\"visible\":{},\"owned\":{},\"tool\":{},\"cloaked\":{},\
             \"minimized\":{},\"fullscreen\":{},\"class\":{},\"title\":{},\"path\":{}}}",
            self.hwnd,
            self.pid,
            self.visible,
            self.owned,
            self.tool,
            self.cloaked,
            self.minimized,
            self.fullscreen,
            string(&self.class),
            string(&self.title),
            string(&self.path),
        )
    }
}

impl ProcessInfo {
    /// Uma linha do modo `processes` (sem a quebra de linha).
    pub fn to_json(&self) -> String {
        format!("{{\"pid\":{},\"name\":{}}}", self.pid, string(&self.name))
    }
}

impl Rect {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"left\":{},\"top\":{},\"right\":{},\"bottom\":{}}}",
            self.left, self.top, self.right, self.bottom
        )
    }
}

impl WindowGeometry {
    /// A linha do modo `info` (sem a quebra de linha).
    pub fn to_json(&self) -> String {
        format!(
            "{{\"fullscreen\":{},\"minimized\":{},\"window\":{},\"monitor\":{}}}",
            self.fullscreen,
            self.minimized,
            self.window.to_json(),
            self.monitor.to_json(),
        )
    }
}

impl MonitorInfo {
    /// Uma linha do modo `monitors` (sem a quebra de linha).
    pub fn to_json(&self) -> String {
        format!(
            "{{\"index\":{},\"device\":{},\"name\":{},\"primary\":{},\"rect\":{}}}",
            self.index,
            string(&self.device),
            string(&self.name),
            self.primary,
            self.rect.to_json(),
        )
    }
}

impl PickerSource {
    /// Uma linha do modo `sources` (sem a quebra de linha). O `hwnd` vai como texto, como no modo
    /// `list`: é um número de 64 bits, que o JavaScript não guarda inteiro.
    pub fn to_json(&self) -> String {
        format!(
            "{{\"id\":{},\"kind\":\"{}\",\"title\":{},\"exe\":{},\"path\":{},\"hwnd\":\"{}\",\
             \"pid\":{},\"monitor\":{},\"minimized\":{},\"fullscreen\":{},\"game\":{}}}",
            string(&self.id),
            self.kind.as_str(),
            string(&self.title),
            string(&self.exe),
            string(&self.path),
            self.hwnd,
            self.pid,
            self.monitor,
            self.minimized,
            self.fullscreen,
            self.game,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceKind;

    #[test]
    fn monitor_and_source_lines() {
        let monitor = MonitorInfo {
            index: 2,
            device: r"\\.\DISPLAY2".into(),
            name: "DELL U2720Q".into(),
            rect: Rect {
                left: -2560,
                top: 0,
                right: 0,
                bottom: 1440,
            },
            primary: false,
        };
        assert_eq!(
            monitor.to_json(),
            "{\"index\":2,\"device\":\"\\\\\\\\.\\\\DISPLAY2\",\"name\":\"DELL U2720Q\",\
             \"primary\":false,\"rect\":{\"left\":-2560,\"top\":0,\"right\":0,\"bottom\":1440}}"
        );
        let source = PickerSource {
            id: "window:132456".into(),
            kind: SourceKind::Window,
            title: "Jogo \"novo\"".into(),
            exe: "jogo.exe".into(),
            path: r"C:\Jogos\jogo.exe".into(),
            hwnd: 132456,
            pid: 4321,
            monitor: 0,
            minimized: true,
            fullscreen: false,
            game: true,
        };
        assert_eq!(
            source.to_json(),
            "{\"id\":\"window:132456\",\"kind\":\"window\",\"title\":\"Jogo \\\"novo\\\"\",\
             \"exe\":\"jogo.exe\",\"path\":\"C:\\\\Jogos\\\\jogo.exe\",\"hwnd\":\"132456\",\
             \"pid\":4321,\"monitor\":0,\"minimized\":true,\"fullscreen\":false,\"game\":true}"
        );
    }

    #[test]
    fn escapes_like_the_csharp_helper() {
        assert_eq!(string("Olá \"mundo\""), "\"Olá \\\"mundo\\\"\"");
        assert_eq!(string("C:\\Jogos\\cs2.exe"), "\"C:\\\\Jogos\\\\cs2.exe\"");
        // O C# não usa \n nem \t: todo caractere de controle vira \u00xx em minúsculas.
        assert_eq!(string("a\nb\tc\u{1f}"), "\"a\\u000ab\\u0009c\\u001f\"");
        assert_eq!(string("emoji 🎮 e acento ç"), "\"emoji 🎮 e acento ç\"");
    }

    #[test]
    fn window_line_has_the_same_keys_in_the_same_order() {
        let window = WindowInfo {
            hwnd: 132456,
            pid: 4321,
            visible: true,
            owned: false,
            tool: false,
            cloaked: false,
            minimized: true,
            fullscreen: false,
            class: "UnrealWindow".into(),
            title: "Jogo".into(),
            path: "C:\\Jogos\\jogo.exe".into(),
        };
        assert_eq!(
            window.to_json(),
            "{\"hwnd\":\"132456\",\"pid\":4321,\"visible\":true,\"owned\":false,\"tool\":false,\
             \"cloaked\":false,\"minimized\":true,\"fullscreen\":false,\"class\":\"UnrealWindow\",\
             \"title\":\"Jogo\",\"path\":\"C:\\\\Jogos\\\\jogo.exe\"}"
        );
    }

    #[test]
    fn geometry_and_process_lines() {
        let geometry = WindowGeometry {
            fullscreen: true,
            minimized: false,
            window: Rect {
                left: -8,
                top: -8,
                right: 1928,
                bottom: 1088,
            },
            monitor: Rect {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080,
            },
        };
        assert_eq!(
            geometry.to_json(),
            "{\"fullscreen\":true,\"minimized\":false,\
             \"window\":{\"left\":-8,\"top\":-8,\"right\":1928,\"bottom\":1088},\
             \"monitor\":{\"left\":0,\"top\":0,\"right\":1920,\"bottom\":1080}}"
        );
        let process = ProcessInfo {
            pid: 7,
            name: "cs2".into(),
        };
        assert_eq!(process.to_json(), "{\"pid\":7,\"name\":\"cs2\"}");
    }
}
