//! Teste da captura do áudio do jogo (a biblioteca está em `lib.rs`).
//!
//!   nimbo-audio include <pid> [segundos] [arquivo.wav]   só o processo e seus filhos
//!   nimbo-audio exclude <pid> [segundos] [arquivo.wav]   tudo menos o processo e seus filhos
//!
//! Captura pelo tempo pedido (padrão 5 s), grava um WAV (padrão `nimbo-audio.wav`) e escreve uma
//! linha em JSON com o que capturou. Erro sai como `ERROR ...` na saída de erro, com código 1,
//! igual ao auxiliar em C#.

use std::fs::File;
use std::io::{self, BufWriter, Seek, SeekFrom, Write};
use std::process::ExitCode;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use nimbo_audio::{BITS_PER_SAMPLE, CHANNELS, Capture, FRAME_BYTES, Mode, SAMPLE_RATE};

const USAGE: &str = "uso: nimbo-audio include|exclude <pid> [segundos] [arquivo.wav]";
/// Quanto esperar além do tempo pedido antes de desistir (o fluxo deveria andar com o relógio).
const GRACE: Duration = Duration::from_secs(3);
const WAV_HEADER: usize = 44;

struct Job {
    mode: Mode,
    seconds: u64,
    path: String,
}

fn parse(args: &[String]) -> Result<Job, String> {
    if !(2..=4).contains(&args.len()) {
        return Err(USAGE.into());
    }
    let pid = args[1].parse().map_err(|_| "pid inválido".to_string())?;
    let mode = match args[0].as_str() {
        "include" => Mode::Include(pid),
        "exclude" => Mode::Exclude(pid),
        _ => return Err("modo inválido".into()),
    };
    let seconds = match args.get(2) {
        Some(text) => match text.parse() {
            Ok(seconds) if seconds > 0 => seconds,
            _ => return Err("segundos inválidos".into()),
        },
        None => 5,
    };
    let path = args.get(3).cloned().unwrap_or("nimbo-audio.wav".into());
    Ok(Job {
        mode,
        seconds,
        path,
    })
}

fn wav_header(data_bytes: u32) -> [u8; WAV_HEADER] {
    let block = CHANNELS * BITS_PER_SAMPLE / 8;
    let mut header = [0; WAV_HEADER];
    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&(data_bytes + WAV_HEADER as u32 - 8).to_le_bytes());
    header[8..16].copy_from_slice(b"WAVEfmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes());
    header[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    header[22..24].copy_from_slice(&CHANNELS.to_le_bytes());
    header[24..28].copy_from_slice(&SAMPLE_RATE.to_le_bytes());
    header[28..32].copy_from_slice(&(SAMPLE_RATE * u32::from(block)).to_le_bytes());
    header[32..34].copy_from_slice(&block.to_le_bytes());
    header[34..36].copy_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    header
}

/// Onde o som capturado vai parar: o arquivo e as medidas.
struct Sink {
    file: BufWriter<File>,
    /// Quadros que faltam para completar o tempo pedido; o que passar disso é ignorado.
    remaining: u64,
    frames: u64,
    peak: u16,
    squares: f64,
    error: Option<io::Error>,
    done: mpsc::Sender<()>,
}

impl Sink {
    fn write(&mut self, pcm: &[u8]) {
        let frames = ((pcm.len() / FRAME_BYTES) as u64).min(self.remaining);
        if frames == 0 || self.error.is_some() {
            return;
        }
        let pcm = &pcm[..frames as usize * FRAME_BYTES];
        for sample in pcm.as_chunks::<2>().0 {
            let value = i16::from_le_bytes(*sample);
            self.peak = self.peak.max(value.unsigned_abs());
            self.squares += f64::from(value) * f64::from(value);
        }
        if let Err(error) = self.file.write_all(pcm) {
            self.error = Some(error);
        }
        self.frames += frames;
        self.remaining -= frames;
        if self.remaining == 0 || self.error.is_some() {
            let _ = self.done.send(());
        }
    }

    /// Volta ao início para escrever o cabeçalho com o tamanho real.
    fn finish(&mut self) -> io::Result<()> {
        if let Some(error) = self.error.take() {
            return Err(error);
        }
        let bytes = u32::try_from(self.frames * FRAME_BYTES as u64).unwrap_or(u32::MAX);
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(&wav_header(bytes))?;
        self.file.flush()
    }
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            c if u32::from(c) < 32 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn run(job: &Job) -> Result<String, String> {
    let mut file = BufWriter::new(File::create(&job.path).map_err(|e| format!("arquivo: {e}"))?);
    file.write_all(&wav_header(0))
        .map_err(|e| format!("arquivo: {e}"))?;
    let (done, finished) = mpsc::channel();
    let sink = Arc::new(Mutex::new(Sink {
        file,
        remaining: job.seconds * u64::from(SAMPLE_RATE),
        frames: 0,
        peak: 0,
        squares: 0.0,
        error: None,
        done,
    }));

    let writer = Arc::clone(&sink);
    let capture = Capture::start(job.mode, move |pcm| {
        if let Ok(mut sink) = writer.lock() {
            sink.write(pcm);
        }
    })
    .map_err(|e| e.to_string())?;
    let started = Instant::now();
    // Se o tempo estourar, o resultado sai mesmo assim: menos quadros que o pedido denuncia o
    // problema.
    let _ = finished.recv_timeout(Duration::from_secs(job.seconds) + GRACE);
    let elapsed = started.elapsed();
    let stats = capture.stop().map_err(|e| e.to_string())?;

    let mut sink = sink.lock().map_err(|_| "a escrita do arquivo caiu")?;
    sink.finish().map_err(|e| format!("arquivo: {e}"))?;
    let samples = sink.frames * u64::from(CHANNELS);
    let rms = if samples == 0 {
        0.0
    } else {
        (sink.squares / samples as f64).sqrt() / 32768.0
    };
    let (mode, pid) = match job.mode {
        Mode::Include(pid) => ("include", pid),
        Mode::Exclude(pid) => ("exclude", pid),
    };
    // `frames` é o que foi para o arquivo; `silence_frames` conta a captura inteira, que anda
    // alguns milissegundos a mais até a parada.
    Ok(format!(
        "{{\"mode\":\"{mode}\",\"pid\":{pid},\"frames\":{},\"duration_s\":{:.3},\"elapsed_s\":{:.3},\
         \"peak\":{:.6},\"rms\":{:.6},\"silence_frames\":{},\
         \"format\":{{\"encoding\":\"pcm_s16le\",\"sample_rate\":{SAMPLE_RATE},\
         \"channels\":{CHANNELS},\"bits_per_sample\":{BITS_PER_SAMPLE}}},\"wav\":{}}}",
        sink.frames,
        sink.frames as f64 / f64::from(SAMPLE_RATE),
        elapsed.as_secs_f64(),
        f64::from(sink.peak) / 32768.0,
        rms,
        stats.silence_frames,
        json_string(&job.path),
    ))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse(&args).and_then(|job| run(&job)) {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("ERROR {message}");
            ExitCode::FAILURE
        }
    }
}
