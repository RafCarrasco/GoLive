//! Envia a tela capturada para navegadores por WebRTC, com **um codificador para todos** os
//! espectadores. Abra http://127.0.0.1:3070 em quantas abas quiser.
//!
//! O vídeo é codificado pela placa de vídeo sem sair da GPU (ver `hw.rs`). Em máquina sem esse
//! codificador, cai para software (OpenH264) em metade da resolução e 30 quadros por segundo.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openh264::OpenH264API;
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, RateControlMode, UsageType,
};
use openh264::formats::{BgraSliceU8, YUVBuffer};
use str0m::bwe::{Bitrate, BweKind};
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
use crate::hw::HwEncoder;

const FPS: u32 = 60;
const BITRATE: u32 = 8_000_000;
/// Altura máxima enviada; telas maiores são reduzidas na GPU.
const MAX_HEIGHT: u32 = 1080;
/// Piso do controle de banda: abaixo disto a imagem em 1080p fica ruim demais.
const MIN_BITRATE: u32 = 800_000;
const SOFTWARE_FPS: u32 = 30;
const SOFTWARE_BITRATE: u32 = 4_000_000;

/// Um quadro já codificado (H.264 Annex B), o mesmo para todos os espectadores.
struct Encoded {
    data: Arc<[u8]>,
    at: Instant,
}

/// O que acorda a conexão de um espectador.
enum Msg {
    Frame(Arc<Encoded>),
    Packet(Vec<u8>, SocketAddr),
    Tick,
}

/// O que o capturador/codificador e as conexões compartilham.
#[derive(Default)]
struct Shared {
    /// Uma fila por espectador: nenhum quadro pode ser pulado, senão a imagem quebra.
    subscribers: Mutex<Vec<Sender<Msg>>>,
    /// Alguém entrou ou perdeu pacotes: o próximo quadro precisa ser completo.
    keyframe: AtomicBool,
    viewers: AtomicUsize,
    encoded: AtomicUsize,
    encoder: Mutex<String>,
    /// Banda estimada de cada espectador, em bits por segundo.
    estimates: Mutex<HashMap<usize, u64>>,
    /// Taxa de bits que o codificador está usando agora.
    target: AtomicU32,
    next_id: AtomicUsize,
}

impl Shared {
    fn publish(&self, data: Vec<u8>) {
        if data.is_empty() {
            return;
        }
        self.encoded.fetch_add(1, Ordering::Relaxed);
        let frame = Arc::new(Encoded {
            data: data.into(),
            at: Instant::now(),
        });
        // Quem saiu teve a fila fechada: sai da lista.
        self.subscribers
            .lock()
            .unwrap()
            .retain(|s| s.send(Msg::Frame(frame.clone())).is_ok());
    }
}

enum Codec264 {
    Hardware(Box<HwEncoder>),
    Software {
        encoder: Box<Encoder>,
        last: Instant,
        small: Vec<u8>,
    },
}

struct Capture {
    shared: Arc<Shared>,
    codec: Option<Codec264>,
    out: Vec<Vec<u8>>,
    checked: Instant,
}

fn software() -> Result<Codec264, AnyError> {
    let config = EncoderConfig::new()
        .bitrate(BitRate::from_bps(SOFTWARE_BITRATE))
        .max_frame_rate(FrameRate::from_hz(SOFTWARE_FPS as f32))
        .usage_type(UsageType::CameraVideoRealTime)
        .rate_control_mode(RateControlMode::Bitrate)
        .complexity(Complexity::Low)
        .skip_frames(false);
    let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)?;
    Ok(Codec264::Software {
        encoder: Box::new(encoder),
        last: Instant::now(),
        small: Vec::new(),
    })
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = Arc<Shared>;
    type Error = AnyError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            shared: ctx.flags,
            codec: None,
            checked: Instant::now(),
            out: Vec::new(),
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
        if self.codec.is_none() {
            let input = (frame.width(), frame.height());
            let scale = f64::from(MAX_HEIGHT.min(input.1)) / f64::from(input.1);
            let output = (
                (f64::from(input.0) * scale) as u32,
                (f64::from(input.1) * scale) as u32,
            );
            let codec = match HwEncoder::new(
                frame.device(),
                frame.device_context(),
                input,
                output,
                FPS,
                BITRATE,
            ) {
                Ok(encoder) => {
                    *self.shared.encoder.lock().unwrap() =
                        format!("{} {}x{}", encoder.name, encoder.width, encoder.height);
                    Codec264::Hardware(Box::new(encoder))
                }
                Err(e) => {
                    eprintln!("sem codificador na placa de vídeo ({e}); usando software");
                    *self.shared.encoder.lock().unwrap() = "OpenH264 (software)".into();
                    software()?
                }
            };
            self.codec = Some(codec);
        }
        // Controle de banda: uma vez por segundo, ajusta a taxa para a conexão mais apertada.
        if self.checked.elapsed() >= Duration::from_secs(1) {
            self.checked = Instant::now();
            let lowest = self
                .shared
                .estimates
                .lock()
                .unwrap()
                .values()
                .copied()
                .min();
            if let Some(lowest) = lowest {
                let wanted = ((lowest * 9 / 10) as u32).clamp(MIN_BITRATE, BITRATE);
                let current = self.shared.target.load(Ordering::Relaxed);
                if wanted.abs_diff(current) > current / 12 {
                    self.shared.target.store(wanted, Ordering::Relaxed);
                    if let Some(Codec264::Hardware(encoder)) = self.codec.as_mut() {
                        encoder.set_bitrate(wanted);
                    }
                }
            }
        }
        let keyframe = self.shared.keyframe.swap(false, Ordering::Relaxed);
        match self.codec.as_mut().unwrap() {
            Codec264::Hardware(encoder) => {
                if !encoder.encode(frame.as_raw_texture(), keyframe, &mut self.out)? && keyframe {
                    // O quadro foi descartado: o pedido de quadro completo vale para o próximo.
                    self.shared.keyframe.store(true, Ordering::Relaxed);
                }
                for data in self.out.drain(..) {
                    self.shared.publish(data);
                }
            }
            Codec264::Software {
                encoder,
                last,
                small,
            } => {
                if last.elapsed()
                    < Duration::from_micros(1_000_000 / u64::from(SOFTWARE_FPS) - 2_000)
                {
                    if keyframe {
                        self.shared.keyframe.store(true, Ordering::Relaxed);
                    }
                    return Ok(());
                }
                *last = Instant::now();
                let mut buffer = frame.buffer()?;
                let (width, height, pitch) = (
                    buffer.width() as usize,
                    buffer.height() as usize,
                    buffer.row_pitch() as usize,
                );
                let raw = buffer.as_raw_buffer();
                // Metade da resolução, com lados pares (exigência do H.264).
                let (w, h) = ((width / 2) & !1, (height / 2) & !1);
                small.resize(w * h * 4, 0);
                for y in 0..h {
                    let row = &raw[y * 2 * pitch..];
                    let out = &mut small[y * w * 4..(y + 1) * w * 4];
                    for x in 0..w {
                        out[x * 4..x * 4 + 4].copy_from_slice(&row[x * 8..x * 8 + 4]);
                    }
                }
                let yuv = YUVBuffer::from_rgb_source(BgraSliceU8::new(small, (w, h)));
                if keyframe {
                    encoder.force_intra_frame();
                }
                let data = encoder.encode(&yuv)?.to_vec();
                self.shared.publish(data);
            }
        }
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
    shared.target.store(BITRATE, Ordering::Relaxed);

    let capture_shared = shared.clone();
    std::thread::spawn(move || {
        let start = || -> Result<(), AnyError> {
            let settings = Settings::new(
                Monitor::primary()?,
                CursorCaptureSettings::Default,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Custom(Duration::from_micros(
                    1_000_000 / u64::from(FPS),
                )),
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
                "{{\"espectadores\":{},\"codificador\":\"{}\",\"alvo_mbps\":{:.1},\"quadros_codificados_por_s\":{:.1},\"cpu_um_nucleo_pct\":{:.1}}}",
                stats.viewers.load(Ordering::Relaxed),
                stats.encoder.lock().unwrap(),
                f64::from(stats.target.load(Ordering::Relaxed)) / 1e6,
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
    stream.write_all(body)?;
    // Fecha só a escrita e espera o navegador fechar o lado dele: fechar de uma vez faz o Windows
    // às vezes cortar a conexão local antes de a resposta ser lida.
    stream.shutdown(std::net::Shutdown::Write)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut sink = [0u8; 256];
    while matches!(stream.read(&mut sink), Ok(n) if n > 0) {}
    Ok(())
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

    let mut rtc = RtcConfig::new()
        .enable_bwe(Some(Bitrate::bps(u64::from(BITRATE) / 2)))
        .build(Instant::now());
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

    let (sender, inbox) = channel();
    shared.subscribers.lock().unwrap().push(sender.clone());
    // Uma thread só escuta a rede e acorda a conexão: nada fica girando à toa.
    let reader = socket.try_clone()?;
    reader.set_read_timeout(Some(Duration::from_secs(1)))?;
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 2000];
        loop {
            match reader.recv_from(&mut buf) {
                Ok((n, source)) => {
                    if sender.send(Msg::Packet(buf[..n].to_vec(), source)).is_err() {
                        return;
                    }
                }
                // ConnectionReset em UDP no Windows é só um aviso ICMP de porta fechada.
                Err(e)
                    if matches!(
                        e.kind(),
                        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::ConnectionReset
                    ) =>
                {
                    // O aviso de porta fechada volta na hora e sem parar: espera um pouco para não
                    // girar à toa. Depois acorda a conexão para ela notar que acabou.
                    if e.kind() == ErrorKind::ConnectionReset {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    if sender.send(Msg::Tick).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
    shared.viewers.fetch_add(1, Ordering::Relaxed);
    let id = shared.next_id.fetch_add(1, Ordering::Relaxed);
    let result = viewer(rtc, &socket, shared, &inbox, id);
    shared.viewers.fetch_sub(1, Ordering::Relaxed);
    shared.estimates.lock().unwrap().remove(&id);
    result
}

/// Uma conexão de espectador: só repassa os quadros que o codificador único produziu. Dorme até
/// chegar um quadro, um pacote da rede ou a hora que o WebRTC pediu.
fn viewer(
    mut rtc: Rtc,
    socket: &UdpSocket,
    shared: &Shared,
    inbox: &Receiver<Msg>,
    id: usize,
) -> Result<(), AnyError> {
    let start = Instant::now();
    let local = socket.local_addr()?;
    let mut video: Option<Mid> = None;
    let mut connected = false;
    loop {
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
                        let target = u64::from(shared.target.load(Ordering::Relaxed));
                        rtc.bwe().set_bitrate(
                            Bitrate::bps(target),
                            Bitrate::bps(u64::from(BITRATE) * 3 / 2),
                        );
                        connected = true;
                        shared.keyframe.store(true, Ordering::Relaxed);
                    }
                    Event::MediaAdded(media) if media.kind == MediaKind::Video => {
                        video = Some(media.mid)
                    }
                    Event::KeyframeRequest(_) => shared.keyframe.store(true, Ordering::Relaxed),
                    // Quanto esta conexão aguenta; o codificador único segue a mais apertada.
                    Event::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => {
                        shared
                            .estimates
                            .lock()
                            .unwrap()
                            .insert(id, estimate.as_u64());
                    }
                    _ => {}
                }
                continue;
            }
        };
        // Quem não conecta em 15 s (página fechada, rede bloqueada) libera a vaga.
        if !rtc.is_alive() || (!connected && start.elapsed() > Duration::from_secs(15)) {
            return Ok(());
        }
        // O controle de banda dita o ritmo de envio pacote a pacote; atrasar esses avisos faz a banda
        // estimada despencar (testado com janelas de 4 ms), então a espera segue exatamente o pedido.
        let wait = timeout.saturating_duration_since(Instant::now());
        let message = inbox.recv_timeout(wait).ok();
        match message {
            Some(Msg::Frame(frame)) => {
                // Antes de conectar não há para onde mandar; ao conectar, pede-se um quadro completo.
                if let (true, Some(mid)) = (connected, video)
                    && let Some(writer) = rtc.writer(mid)
                {
                    let pt = writer
                        .payload_params()
                        .find(|p| p.spec().codec == Codec::H264)
                        .map(|p| p.pt());
                    if let Some(pt) = pt {
                        let micros = frame.at.saturating_duration_since(start).as_micros() as u64;
                        writer.write(
                            pt,
                            frame.at,
                            MediaTime::from_90khz(micros * 9 / 100),
                            frame.data.clone(),
                        )?;
                    }
                }
            }
            Some(Msg::Packet(data, source)) => {
                let receive = Receive {
                    proto: Protocol::Udp,
                    source,
                    destination: local,
                    contents: data.as_slice().try_into()?,
                };
                rtc.handle_input(Input::Receive(Instant::now(), receive))?;
            }
            Some(Msg::Tick) | None => rtc.handle_input(Input::Timeout(Instant::now()))?,
        }
    }
}
