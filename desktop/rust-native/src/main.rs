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
//! E os dados do seletor "o que transmitir", que o C# não tem:
//!
//!   nimbo-native monitors                        monitores, um por linha em JSON
//!   nimbo-native sources                         o que o seletor oferece, na ordem dele
//!   nimbo-native thumb monitor <índice> <arq>    miniatura de um monitor (.png grava PNG; outra
//!   nimbo-native thumb window <hwnd> <arq>       extensão grava JPEG), e o tempo que levou
//!   nimbo-native thumbs <pasta>                  miniaturas de tudo o que `sources` lista
//!   nimbo-native icon <hwnd> <arq.png> [tamanho] ícone do aplicativo da janela
//!
//! Erros saem como `ERROR <motivo>` na saída de erro, com código 1.

use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

use nimbo_native::{
    CaptureTarget, Hwnd, IconSource, ImageFormat, SourceKind, WatchEvent, WatchTarget,
};

const USAGE: &str = "uso: list | processes | info <hwnd> | restore <hwnd> | watch <hwnd> | \
     watchpid <pid> | monitors | sources | thumb monitor <índice> <arquivo> | \
     thumb window <hwnd> <arquivo> | thumbs <pasta> | icon <hwnd> <arquivo.png> [tamanho]";

/// O tamanho que o seletor do Electron pede ao Chromium (main.cjs:376).
const THUMBNAIL: (u32, u32) = (400, 250);
/// Ícone ao lado do nome no seletor, com folga para telas de alta densidade.
const ICON_SIZE: u32 = 32;

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
        ["monitors"] => {
            print(nimbo_native::list_monitors().iter().map(|m| m.to_json()));
            Ok(())
        }
        ["sources"] => {
            print(
                nimbo_native::picker_sources(&[])
                    .iter()
                    .map(|s| s.to_json()),
            );
            Ok(())
        }
        ["thumb", "monitor", index, out] => match index.trim().parse() {
            Ok(index) => thumb(CaptureTarget::Monitor(index), out),
            Err(_) => Err("monitor inválido".into()),
        },
        ["thumb", "window", hwnd, out] => {
            window(hwnd).and_then(|hwnd| thumb(CaptureTarget::Window(hwnd), out))
        }
        ["thumbs", folder] => thumbs(folder),
        ["icon", hwnd, out] => window(hwnd).and_then(|hwnd| icon(hwnd, out, ICON_SIZE)),
        ["icon", hwnd, out, size] => match size.trim().parse() {
            Ok(size) => window(hwnd).and_then(|hwnd| icon(hwnd, out, size)),
            Err(_) => Err("tamanho inválido".into()),
        },
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

/// Uma miniatura gravada em arquivo. A extensão escolhe o formato: `.png` grava PNG, qualquer
/// outra grava JPEG (o formato que a biblioteca usa por padrão).
fn thumb(target: CaptureTarget, out: &str) -> Result<(), String> {
    let format = if out.to_lowercase().ends_with(".png") {
        ImageFormat::Png
    } else {
        ImageFormat::Jpeg
    };
    let started = Instant::now();
    let thumbnail = nimbo_native::capture_thumbnail_as(target, THUMBNAIL.0, THUMBNAIL.1, format)
        .map_err(|e| e.to_string())?;
    let elapsed = started.elapsed();
    std::fs::write(out, &thumbnail.data).map_err(|e| e.to_string())?;
    print([format!(
        "{{\"width\":{},\"height\":{},\"bytes\":{},\"ms\":{}}}",
        thumbnail.width,
        thumbnail.height,
        thumbnail.data.len(),
        elapsed.as_millis(),
    )]);
    Ok(())
}

/// As miniaturas de tudo o que o seletor oferece, gravadas na pasta: uma linha por item (com o
/// tempo de cada uma) e, no fim, o total em sequência e o total pedindo todas ao mesmo tempo,
/// que é como o seletor pede.
fn thumbs(folder: &str) -> Result<(), String> {
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let targets: Vec<(String, CaptureTarget)> = nimbo_native::picker_sources(&[])
        .into_iter()
        .filter_map(|source| {
            let target = match source.kind {
                SourceKind::Screen => CaptureTarget::Monitor(source.monitor),
                SourceKind::Window => CaptureTarget::Window(source.hwnd),
                // Jogo sem janela não tem o que fotografar.
                SourceKind::Game => return None,
            };
            Some((source.id, target))
        })
        .collect();
    let capture =
        |target: CaptureTarget| nimbo_native::capture_thumbnail(target, THUMBNAIL.0, THUMBNAIL.1);

    let mut lines = Vec::new();
    let mut captured = 0;
    let sequence = Instant::now();
    for (id, target) in &targets {
        let started = Instant::now();
        let result = capture(*target);
        let ms = started.elapsed().as_millis();
        lines.push(match result {
            Ok(thumbnail) => {
                captured += 1;
                let file = Path::new(folder).join(format!("{}.jpg", id.replace(':', "-")));
                std::fs::write(file, &thumbnail.data).map_err(|e| e.to_string())?;
                format!(
                    "{{\"id\":\"{id}\",\"width\":{},\"height\":{},\"bytes\":{},\"ms\":{ms}}}",
                    thumbnail.width,
                    thumbnail.height,
                    thumbnail.data.len(),
                )
            }
            Err(error) => format!("{{\"id\":\"{id}\",\"error\":\"{error}\",\"ms\":{ms}}}"),
        });
    }
    let sequence = sequence.elapsed().as_millis();

    let together = Instant::now();
    let parallel = thread::scope(|scope| {
        let pending: Vec<_> = targets
            .iter()
            .map(|(_, target)| scope.spawn(|| capture(*target).is_ok()))
            .collect();
        pending
            .into_iter()
            .filter_map(|capture| capture.join().ok())
            .filter(|&captured| captured)
            .count()
    });
    lines.push(format!(
        "{{\"sources\":{},\"captured\":{captured},\"sequence_ms\":{sequence},\
         \"parallel_captured\":{parallel},\"parallel_ms\":{}}}",
        targets.len(),
        together.elapsed().as_millis(),
    ));
    print(lines);
    Ok(())
}

/// O ícone da janela (ou do executável dela) gravado em PNG.
fn icon(hwnd: Hwnd, out: &str, size: u32) -> Result<(), String> {
    let started = Instant::now();
    let png = nimbo_native::app_icon(IconSource::Window(hwnd), size).map_err(|e| e.to_string())?;
    let elapsed = started.elapsed();
    std::fs::write(out, &png).map_err(|e| e.to_string())?;
    print([format!(
        "{{\"size\":{size},\"bytes\":{},\"ms\":{}}}",
        png.len(),
        elapsed.as_millis(),
    )]);
    Ok(())
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
