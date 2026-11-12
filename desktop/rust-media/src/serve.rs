//! Etapas 3 e 4 do plano: envia a tela capturada para navegadores por WebRTC, com **um codificador
//! para todos** os espectadores. Abra http://127.0.0.1:3070 em quantas abas quiser.
//!
//! Limites desta versão: codifica por software (OpenH264) em metade da resolução e a 30 quadros/s,
//! sem controle de banda. A codificação pela placa de vídeo (etapa 2) entra aqui em seguida.

use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openh264::OpenH264API;
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, RateControlMode, UsageType,
};
use openh264::formats::{BgraSliceU8, YUVBuffer};
use str0m::change::SdpOffer;
use str0m::format::Codec;
use str0m::media::{MediaKind, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use crate::AnyError;

const FPS: u32 = 30;
const BITRATE: u32 = 4_000_000;

/// Um quadro já codificado (H.264 Annex B), pronto para todos os espectadores.
struct Encoded {
    seq: u64,
    data: Arc<[u8]>,
    at: Instant,
}

/// O que o capturador/codificador e as conexões compartilham.
#[derive(Default)]
struct Shared {
    latest: Mutex<Option<Encoded>>,
    /// Alguém entrou ou perdeu pacotes: o próximo quadro precisa ser completo.
    keyframe: AtomicBool,
    viewers: AtomicUsize,
    encoded: AtomicUsize,
}

struct Capture {
    shared: Arc<Shared>,
    encoder: Encoder,
    last: Instant,
    seq: u64,
    small: Vec<u8>,
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = Arc<Shared>;
    type Error = AnyError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(BITRATE))
            .max_frame_rate(FrameRate::from_hz(FPS as f32))
            .usage_type(UsageType::CameraVideoRealTime)
            .rate_control_mode(RateControlMode::Bitrate)
            .complexity(Complexity::Low)
            .skip_frames(false);
        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)?;
        Ok(Self {
            shared: ctx.flags,
            encoder,
            last: Instant::now(),
            seq: 0,
            small: Vec::new(),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Sem ninguém assistindo não codifica nada.
        if self.shared.viewers.load(Ordering::Relaxed) == 0 {
            return Ok(());
        }
        if self.last.elapsed() < Duration::from_micros(1_000_000 / u64::from(FPS) - 2_000) {
            return Ok(());
        }
        self.last = Instant::now();

        let mut buffer = frame.buffer()?;
        let (width, height, pitch) = (
            buffer.width() as usize,
            buffer.height() as usize,
            buffer.row_pitch() as usize,
        );
        let raw = buffer.as_raw_buffer();
        // Metade da resolução, com lados pares (exigência do H.264).
        let (w, h) = ((width / 2) & !1, (height / 2) & !1);
        self.small.resize(w * h * 4, 0);
        for y in 0..h {
            let row = &raw[y * 2 * pitch..];
            let out = &mut self.small[y * w * 4..(y + 1) * w * 4];
            for x in 0..w {
                out[x * 4..x * 4 + 4].copy_from_slice(&row[x * 8..x * 8 + 4]);
            }
        }
        let yuv = YUVBuffer::from_rgb_source(BgraSliceU8::new(&self.small, (w, h)));
        if self.shared.keyframe.swap(false, Ordering::Relaxed) {
            self.encoder.force_intra_frame();
        }
        let data = self.encoder.encode(&yuv)?.to_vec();
        if data.is_empty() {
            return Ok(());
        }
        self.seq += 1;
        self.shared.encoded.fetch_add(1, Ordering::Relaxed);
        *self.shared.latest.lock().unwrap() = Some(Encoded {
            seq: self.seq,
            data: data.into(),
            at: Instant::now(),
        });
        Ok(())
    }
}

/// Endereço da máquina na rede local (o navegador não aceita 127.0.0.1 para mídia).
fn local_ip() -> IpAddr {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("8.8.8.8:80").and_then(|()| s.local_addr()))
        .map_or(IpAddr::from([127, 0, 0, 1]), |a| a.ip())
}

pub fn run(port: u16) -> Result<(), AnyError> {
    str0m::crypto::from_feature_flags().install_process_default();
    let shared = Arc::new(Shared::default());

    let capture_shared = shared.clone();
    std::thread::spawn(move || {
        let start = || -> Result<(), AnyError> {
            let settings = Settings::new(
                Monitor::primary()?,
                CursorCaptureSettings::Default,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Custom(Duration::from_micros(16_666)),
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                capture_shared,
            );
            Capture::start(settings).map_err(|e| format!("captura falhou: {e}"))?;
            Ok(())
        };
        if let Err(e) = start() {
            eprintln!("{e}");
            std::process::exit(1);
        }
    });

    let stats = shared.clone();
    std::thread::spawn(move || {
        let (mut last_cpu, mut last_frames) = (crate::process_cpu(), 0);
        loop {
            std::thread::sleep(Duration::from_secs(5));
            let (now_cpu, frames) = (crate::process_cpu(), stats.encoded.load(Ordering::Relaxed));
            println!(
                "{{\"espectadores\":{},\"quadros_codificados_por_s\":{:.1},\"cpu_um_nucleo_pct\":{:.1}}}",
                stats.viewers.load(Ordering::Relaxed),
                (frames - last_frames) as f64 / 5.0,
                now_cpu.saturating_sub(last_cpu).as_secs_f64() / 5.0 * 100.0,
            );
            (last_cpu, last_frames) = (now_cpu, frames);
        }
    });

    let listener = TcpListener::bind(("127.0.0.1", port))?;
    println!("Abra http://127.0.0.1:{port} no navegador");
    for stream in listener.incoming().flatten() {
        let shared = shared.clone();
        std::thread::spawn(move || {
            if let Err(e) = http(stream, &shared) {
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
    stream.write_all(body)
}

fn http(mut stream: TcpStream, shared: &Shared) -> Result<(), AnyError> {
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
    let offer: SdpOffer = serde_json::from_slice(&body)?;

    let mut rtc = RtcConfig::new().build(Instant::now());
    let socket = UdpSocket::bind(SocketAddr::new(local_ip(), 0))?;
    rtc.add_local_candidate(Candidate::host(socket.local_addr()?, "udp")?);
    let answer = rtc.sdp_api().accept_offer(offer)?;
    respond(
        &mut stream,
        "200 OK",
        "application/json",
        &serde_json::to_vec(&answer)?,
    )?;
    drop(stream);

    shared.viewers.fetch_add(1, Ordering::Relaxed);
    let result = viewer(rtc, &socket, shared);
    shared.viewers.fetch_sub(1, Ordering::Relaxed);
    result
}

/// Uma conexão de espectador: só repassa os quadros que o codificador único produziu.
fn viewer(mut rtc: Rtc, socket: &UdpSocket, shared: &Shared) -> Result<(), AnyError> {
    let start = Instant::now();
    let local = socket.local_addr()?;
    let mut buf = vec![0; 2000];
    let mut video: Option<Mid> = None;
    let mut connected = false;
    let mut sent = 0u64;
    loop {
        if connected && let Some(mid) = video {
            let frame = {
                let latest = shared.latest.lock().unwrap();
                latest
                    .as_ref()
                    .filter(|f| f.seq != sent)
                    .map(|f| (f.seq, f.data.clone(), f.at))
            };
            if let Some((seq, data, at)) = frame {
                if let Some(writer) = rtc.writer(mid) {
                    let pt = writer
                        .payload_params()
                        .find(|p| p.spec().codec == Codec::H264)
                        .map(|p| p.pt());
                    if let Some(pt) = pt {
                        let micros = at.saturating_duration_since(start).as_micros() as u64;
                        writer.write(pt, at, MediaTime::from_90khz(micros * 9 / 100), data)?;
                    }
                }
                sent = seq;
            }
        }
        let timeout = match rtc.poll_output()? {
            Output::Timeout(at) => at,
            Output::Transmit(packet) => {
                socket.send_to(&packet.contents, packet.destination)?;
                continue;
            }
            Output::Event(event) => {
                match event {
                    Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                        return Ok(());
                    }
                    Event::Connected => {
                        connected = true;
                        shared.keyframe.store(true, Ordering::Relaxed);
                    }
                    Event::MediaAdded(media) if media.kind == MediaKind::Video => {
                        video = Some(media.mid)
                    }
                    Event::KeyframeRequest(_) => shared.keyframe.store(true, Ordering::Relaxed),
                    _ => {}
                }
                continue;
            }
        };
        if !rtc.is_alive() {
            return Ok(());
        }
        // Acorda pelo menos a cada 5 ms para pegar o quadro novo do codificador.
        let wait = timeout
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(5));
        if wait.is_zero() {
            rtc.handle_input(Input::Timeout(Instant::now()))?;
            continue;
        }
        socket.set_read_timeout(Some(wait))?;
        buf.resize(2000, 0);
        let input = match socket.recv_from(&mut buf) {
            Ok((n, source)) => {
                buf.truncate(n);
                Input::Receive(
                    Instant::now(),
                    Receive {
                        proto: Protocol::Udp,
                        source,
                        destination: local,
                        contents: buf.as_slice().try_into()?,
                    },
                )
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                Input::Timeout(Instant::now())
            }
            Err(e) => return Err(e.into()),
        };
        rtc.handle_input(input)?;
    }
}
