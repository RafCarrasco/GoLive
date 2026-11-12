//! Os modos do programa auxiliar em C# que não são de áudio, com a mesma saída, para comparar
//! os dois lado a lado e para o Electron poder trocar um pelo outro sem mudar nada.
//!
//!   nimbo-native list            janelas de aplicativo abertas, uma por linha em JSON
//!   nimbo-native processes       processos em execução, um por linha em JSON
//!   nimbo-native info <hwnd>     retângulo da janela e do monitor dela, e se cobre o monitor
//!   nimbo-native restore <hwnd>  traz a janela de volta
//!   nimbo-native watch <hwnd>    escreve 1 quando o jogo está na frente, 0 quando sai e x quando
//!                                o jogo fecha; até a entrada padrão fechar
//!   nimbo-native watchpid <pid>  o mesmo, a partir do processo do jogo
//!
//! Erros saem como `ERROR <motivo>` na saída de erro, com código 1.

use std::io::{self, Write};
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;

use nimbo_native::{Hwnd, WatchEvent, WatchTarget};

const USAGE: &str =
    "uso: list | processes | info <hwnd> | restore <hwnd> | watch <hwnd> | watchpid <pid>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = match args.as_slice() {
        ["list"] => {
            print(nimbo_native::list_windows().iter().map(|w| w.to_json()));
            Ok(())
        }
        ["processes"] => {
            print(nimbo_native::list_processes().iter().map(|p| p.to_json()));
            Ok(())
        }
        ["info", hwnd] => window(hwnd).and_then(|hwnd| {
            let geometry = nimbo_native::window_info(hwnd).map_err(|e| e.to_string())?;
            print([geometry.to_json()]);
            Ok(())
        }),
        ["restore", hwnd] => window(hwnd).map(nimbo_native::restore),
        ["watch", hwnd] => window(hwnd).and_then(|hwnd| watch(WatchTarget::Window(hwnd))),
        ["watchpid", pid] => match pid.trim().parse() {
            Ok(pid) => watch(WatchTarget::Process(pid)),
            Err(_) => Err("pid inválido".into()),
        },
        ["exclude" | "include" | "window", _] => {
            Err("o áudio continua no nimbo-audio.exe (este programa não captura som)".into())
        }
        [_, _] => Err("modo inválido".into()),
        _ => Err(USAGE.into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            // O C# termina a linha de erro com \r\n (Console.Error.WriteLine).
            let _ = write!(io::stderr(), "ERROR {message}\r\n");
            ExitCode::from(1)
        }
    }
}

fn window(text: &str) -> Result<Hwnd, String> {
    text.trim().parse().map_err(|_| "janela inválida".into())
}

/// Uma linha por item, terminada só em `\n` como no C#, escrita de uma vez.
fn print(lines: impl IntoIterator<Item = String>) {
    let mut text = String::new();
    for line in lines {
        text.push_str(&line);
        text.push('\n');
    }
    let mut out = io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

/// Vigia até o jogo fechar ou a entrada padrão fechar (o Nimbo parou a live ou saiu).
fn watch(target: WatchTarget) -> Result<(), String> {
    let (done, finished) = mpsc::channel::<()>();
    let exited = done.clone();
    let watching = nimbo_native::watch(target, move |event| {
        let line = match event {
            WatchEvent::Foreground(true) => "1\n",
            WatchEvent::Foreground(false) => "0\n",
            WatchEvent::Exited => "x\n",
        };
        let mut out = io::stdout().lock();
        let written = out.write_all(line.as_bytes()).and_then(|()| out.flush());
        // Sem ninguém lendo a saída não há por que continuar.
        if written.is_err() || event == WatchEvent::Exited {
            let _ = exited.send(());
        }
    })
    .map_err(|e| e.to_string())?;
    thread::spawn(move || {
        let _ = io::copy(&mut io::stdin(), &mut io::sink());
        let _ = done.send(());
    });
    let _ = finished.recv();
    // Espera a vigia: o primeiro estado sai mesmo se a entrada já chegou fechada, como no C#.
    watching.stop();
    Ok(())
}
