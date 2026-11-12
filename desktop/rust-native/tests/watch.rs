//! A vigia do jogo contra um processo de verdade: um `cmd` escondido, parado esperando entrada.

use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use nimbo_native::{Error, WatchEvent, WatchTarget, watch};

/// Sem janela de console: o teste não pode piscar nada na tela.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PATIENCE: Duration = Duration::from_secs(5);

fn idle_process() -> Child {
    Command::new("cmd")
        .args(["/c", "pause"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .expect("cmd.exe")
}

fn watch_process(pid: u32) -> (nimbo_native::Watch, Receiver<WatchEvent>) {
    let (send, events) = mpsc::channel();
    let watching = watch(WatchTarget::Process(pid), move |event| {
        let _ = send.send(event);
    })
    .expect("vigia");
    (watching, events)
}

#[test]
fn reports_background_then_exit_when_the_process_is_killed() {
    let mut child = idle_process();
    let (watching, events) = watch_process(child.id());
    assert_eq!(watching.pid(), child.id());
    // Processo sem janela nunca está na frente.
    assert_eq!(
        events.recv_timeout(PATIENCE),
        Ok(WatchEvent::Foreground(false))
    );
    // Sem mudança, sem evento.
    assert!(events.recv_timeout(Duration::from_millis(700)).is_err());
    assert!(!watching.is_finished());

    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(events.recv_timeout(PATIENCE), Ok(WatchEvent::Exited));
    // `Exited` é o último: a thread termina e solta o canal.
    assert!(events.recv_timeout(PATIENCE).is_err());
    // O canal fecha um instante antes de a thread constar como terminada.
    let deadline = Instant::now() + PATIENCE;
    while !watching.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(watching.is_finished());
}

#[test]
fn stop_ends_the_watch_while_the_process_lives() {
    let mut child = idle_process();
    let (watching, events) = watch_process(child.id());
    assert_eq!(
        events.recv_timeout(PATIENCE),
        Ok(WatchEvent::Foreground(false))
    );
    watching.stop();
    // Parada não é saída do jogo: o canal fecha sem `Exited`.
    assert!(events.recv_timeout(PATIENCE).is_err());
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn a_process_that_already_exited_reports_exit_right_away() {
    let mut child = idle_process();
    child.kill().unwrap();
    child.wait().unwrap();
    // `child` segue vivo aqui, então o Windows não reaproveita o pid durante o teste.
    let (_watching, events) = watch_process(child.id());
    assert_eq!(events.recv_timeout(PATIENCE), Ok(WatchEvent::Exited));
}

#[test]
fn a_window_that_does_not_exist_cannot_be_watched() {
    let result = watch(WatchTarget::Window(0), |_| {});
    assert_eq!(result.err(), Some(Error::WindowNotFound));
}
