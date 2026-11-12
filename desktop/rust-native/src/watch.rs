//! Vigia do jogo: avisa quando ele está na frente, quando sai da frente (Alt+Tab ou minimizado)
//! e quando fecha. O Nimbo pausa o vídeo fora do jogo e encerra a live quando o jogo fecha.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::{Error, Hwnd, process, window};

/// De quanto em quanto tempo olha o jogo (o mesmo intervalo do C#).
const POLL: Duration = Duration::from_millis(250);

/// O que vigiar. Uma janela vale pelo processo dela no momento em que a vigia começa.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchTarget {
    Window(Hwnd),
    Process(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchEvent {
    /// `true`: uma janela do jogo está na frente; `false`: saiu da frente. Só chega quando muda
    /// (e uma vez no começo). No C#, as linhas `1` e `0`.
    Foreground(bool),
    /// O processo do jogo terminou; é o último evento. No C#, a linha `x`.
    Exited,
}

/// Uma vigia em andamento. Para ao ser solta (ou com [`Watch::stop`]).
#[derive(Debug)]
pub struct Watch {
    pid: u32,
    stop: Option<Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

/// Começa a vigiar e chama `on_event` (numa thread própria) a cada mudança. O primeiro estado
/// sempre é avisado, mesmo que a vigia seja parada logo em seguida.
///
/// Olha o processo, e não uma janela: jogos recriam a janela ao trocar de modo de tela.
pub fn watch(
    target: WatchTarget,
    mut on_event: impl FnMut(WatchEvent) + Send + 'static,
) -> Result<Watch, Error> {
    let pid = match target {
        WatchTarget::Process(pid) => pid,
        WatchTarget::Window(hwnd) => match window::owner_pid(window::handle(hwnd)) {
            0 => return Err(Error::WindowNotFound),
            pid => pid,
        },
    };
    let (stop, stopped) = mpsc::channel::<()>();
    let thread = thread::spawn(move || {
        let mut last = None;
        loop {
            if !process::is_running(pid) {
                on_event(WatchEvent::Exited);
                return;
            }
            let active = window::is_foreground(pid);
            if last != Some(active) {
                on_event(WatchEvent::Foreground(active));
                last = Some(active);
            }
            // Qualquer coisa que não seja "passou o tempo" é o pedido de parada (canal fechado).
            if stopped.recv_timeout(POLL) != Err(RecvTimeoutError::Timeout) {
                return;
            }
        }
    });
    Ok(Watch {
        pid,
        stop: Some(stop),
        thread: Some(thread),
    })
}

impl Watch {
    /// Processo vigiado.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// A vigia já acabou sozinha (o jogo fechou).
    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }

    /// Para de vigiar e espera a thread terminar; depois disso `on_event` não é mais chamado.
    pub fn stop(self) {}
}

impl Drop for Watch {
    fn drop(&mut self) {
        // Fechar o canal acorda a thread na hora, sem esperar o próximo intervalo.
        self.stop.take();
        if let Some(thread) = self.thread.take()
            // Solta de dentro do próprio `on_event`: esperar aqui seria esperar a si mesma.
            && thread.thread().id() != thread::current().id()
        {
            let _ = thread.join();
        }
    }
}
