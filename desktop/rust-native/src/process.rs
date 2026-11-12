//! Processos: a lista (acha o jogo mesmo quando nenhuma janela dele aparece), o caminho do
//! executável e se um processo ainda está rodando.

use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
};
use windows::core::PWSTR;

use crate::wide;

/// Código de saída de um processo que ainda não terminou.
const STILL_ACTIVE: u32 = 259;

/// Um processo em execução. O nome vem sem `.exe`, como o Nimbo compara com a lista de jogos.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
}

/// Processos em execução, na ordem em que o Windows os lista (mais antigos primeiro).
pub fn list_processes() -> Vec<ProcessInfo> {
    let mut processes = Vec::new();
    // SAFETY: pede uma fotografia da lista de processos; não recebe ponteiros.
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return processes;
    };
    let snapshot = Owned(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: `entry` é local e `dwSize` diz o tamanho certo; `snapshot` está aberto.
    let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_ok();
    while more {
        processes.push(ProcessInfo {
            pid: entry.th32ProcessID,
            name: display_name(entry.th32ProcessID, &wide(&entry.szExeFile)),
        });
        // SAFETY: mesmas condições da primeira chamada.
        more = unsafe { Process32NextW(snapshot.0, &mut entry) }.is_ok();
    }
    processes
}

/// O nome que o C# (`Process.ProcessName`) dá ao processo, para as duas listas baterem.
fn display_name(pid: u32, image: &str) -> String {
    match (pid, image) {
        // O Windows chama o processo 0 de "[System Process]"; o .NET, de "Idle".
        (0, _) => "Idle".into(),
        (_, "") => pid.to_string(),
        _ => short_name(image).into(),
    }
}

/// Tira o `.exe` do fim (em qualquer caixa); outra extensão fica, como no .NET.
fn short_name(image: &str) -> &str {
    let stem = image.len().saturating_sub(4);
    match image.get(stem..) {
        Some(extension) if extension.eq_ignore_ascii_case(".exe") => &image[..stem],
        _ => image,
    }
}

/// Caminho do executável do processo; vazio se ele não existe ou não deixa consultar.
pub(crate) fn path(pid: u32) -> String {
    let Ok(process) = open(pid) else {
        return String::new();
    };
    let mut buffer = [0u16; 1024];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` é local e `length` leva a capacidade dele; o handle está aberto.
    let ok = unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    match ok {
        Ok(()) => wide(&buffer),
        Err(_) => String::new(),
    }
}

/// O processo ainda está rodando? Sem permissão para consultar (processo protegido), considera
/// que sim: a live só acaba quando dá para ter certeza de que o jogo fechou.
pub(crate) fn is_running(pid: u32) -> bool {
    match open(pid) {
        // Parâmetro inválido = esse processo não existe mais; outro erro = sem permissão.
        Err(error) => error.code() != ERROR_INVALID_PARAMETER.to_hresult(),
        Ok(process) => {
            let mut code = 0u32;
            // SAFETY: `code` é local e o handle está aberto.
            let ok = unsafe { GetExitCodeProcess(process.0, &mut code) }.is_ok();
            !ok || code == STILL_ACTIVE
        }
    }
}

/// Abre o processo só para consulta (o acesso mínimo, que até processos protegidos costumam dar).
fn open(pid: u32) -> windows::core::Result<Owned> {
    // SAFETY: só abre um handle de consulta; não recebe ponteiros.
    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.map(Owned)
}

/// Handle do Windows que se fecha sozinho.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: o handle veio de uma abertura bem-sucedida e só é fechado aqui.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_dotnet_process_name() {
        assert_eq!(short_name("cs2.exe"), "cs2");
        assert_eq!(
            short_name("VALORANT-Win64-Shipping.EXE"),
            "VALORANT-Win64-Shipping"
        );
        assert_eq!(short_name("Memory Compression"), "Memory Compression");
        assert_eq!(short_name("installer.tmp"), "installer.tmp");
        assert_eq!(short_name("jogo.exe.bak"), "jogo.exe.bak");
        assert_eq!(short_name("ação.exe"), "ação");
        assert_eq!(display_name(0, "[System Process]"), "Idle");
        assert_eq!(display_name(4, "System"), "System");
        assert_eq!(display_name(1234, ""), "1234");
    }

    #[test]
    fn this_process_is_listed_running_and_has_a_path() {
        let pid = std::process::id();
        let listed = list_processes();
        let me = listed
            .iter()
            .find(|p| p.pid == pid)
            .expect("processo atual na lista");
        let exe = std::env::current_exe().unwrap();
        assert_eq!(me.name, exe.file_stem().unwrap().to_string_lossy());
        assert!(is_running(pid));
        assert!(path(pid).eq_ignore_ascii_case(&exe.to_string_lossy()));
    }

    #[test]
    fn process_zero_is_never_a_running_game() {
        // O Windows recusa abrir o processo 0 com "parâmetro inválido", igual a um que já saiu.
        assert!(!is_running(0));
        assert_eq!(path(0), "");
    }
}
