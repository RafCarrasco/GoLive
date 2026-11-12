//! Motor de mídia do Nimbo em Rust: captura, codificação pela placa e envio WebRTC.
//! Ver `docs/rust-app.md` para o plano e os números medidos.

pub mod engine;
pub mod hw;

use std::time::Duration;

pub type AnyError = Box<dyn std::error::Error + Send + Sync>;

/// Tempo de CPU (usuário + núcleo) que este processo já gastou.
pub fn process_cpu() -> Duration {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    // SAFETY: os quatro ponteiros apontam para variáveis locais válidas durante a chamada.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    if ok.is_err() {
        return Duration::ZERO;
    }
    let ticks = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
    Duration::from_nanos((ticks(kernel) + ticks(user)) * 100)
}
