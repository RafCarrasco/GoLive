//! `nimbo-media serve [porta]`: página de teste do motor. Abra http://127.0.0.1:3070 em quantas
//! abas quiser; cada uma vira um espectador da tela principal.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use nimbo_media::engine::{Engine, Quality, Source};

use crate::AnyError;

pub fn run(port: u16) -> Result<(), AnyError> {
    let engine = Arc::new(Engine::new());
    engine.start(Source::PrimaryMonitor, Quality::default())?;

    let stats = engine.clone();
    std::thread::spawn(move || {
        let (mut last_cpu, mut last_frames) = (crate::process_cpu(), 0);
        loop {
            std::thread::sleep(Duration::from_secs(5));
            let (now_cpu, s) = (crate::process_cpu(), stats.stats());
            println!(
                "{{\"espectadores\":{},\"codificador\":\"{}\",\"alvo_mbps\":{:.1},\"quadros_codificados_por_s\":{:.1},\"cpu_um_nucleo_pct\":{:.1}}}",
                s.viewers,
                s.encoder,
                f64::from(s.target_bitrate) / 1e6,
                (s.frames_encoded - last_frames) as f64 / 5.0,
                now_cpu.saturating_sub(last_cpu).as_secs_f64() / 5.0 * 100.0,
            );
            (last_cpu, last_frames) = (now_cpu, s.frames_encoded);
        }
    });

    let listener = TcpListener::bind(("127.0.0.1", port))?;
    println!("Abra http://127.0.0.1:{port} no navegador");
    for stream in listener.incoming().flatten() {
        let engine = engine.clone();
        std::thread::spawn(move || {
            if let Err(e) = http(stream, &engine) {
                eprintln!("http: {e}");
            }
        });
    }
    Ok(())
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    // Fecha só a escrita e espera o navegador fechar o lado dele: fechar de uma vez faz o Windows
    // às vezes cortar a conexão local antes de a resposta ser lida.
    stream.shutdown(std::net::Shutdown::Write)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut sink = [0u8; 256];
    while matches!(stream.read(&mut sink), Ok(n) if n > 0) {}
    Ok(())
}

fn http(mut stream: TcpStream, engine: &Engine) -> Result<(), AnyError> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request = String::new();
    reader.read_line(&mut request)?;
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse()?;
        }
    }
    if request.starts_with("GET / ") {
        return Ok(respond(
            &mut stream,
            "200 OK",
            "text/html; charset=utf-8",
            include_bytes!("viewer.html"),
        )?);
    }
    if !request.starts_with("POST /offer ") || length == 0 || length > 256 * 1024 {
        return Ok(respond(&mut stream, "404 Not Found", "text/plain", b"")?);
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let (_, answer) = engine.accept(&body)?;
    Ok(respond(&mut stream, "200 OK", "application/json", &answer)?)
}
