//! Motor de mídia: captura uma tela ou janela, codifica uma vez e envia por WebRTC para cada
//! espectador. É o que a casca do app (e o modo `serve` de teste) usa.
//!
//! - Um codificador para todos: a mesma sequência H.264 vai para cada conexão.
//! - O vídeo é codificado pela placa sem sair da GPU (`hw.rs`); sem esse codificador, cai para
//!   software (OpenH264) em metade da resolução e 30 quadros por segundo.
//! - Controle de banda: a taxa do codificador segue o espectador com a rede mais apertada.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, Once};
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
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use crate::AnyError;
use crate::hw::HwEncoder;

/// Piso do controle de banda: abaixo disto a imagem fica ruim demais.
const MIN_BITRATE: u32 = 800_000;
const SOFTWARE_FPS: u32 = 30;
const SOFTWARE_BITRATE: u32 = 4_000_000;
/// Servidores STUN: os mesmos do site, para descobrir o endereço público.
const STUN_SERVERS: [&str; 2] = ["stun.cloudflare.com:3478", "stun.l.google.com:19302"];

/// O que capturar.
#[derive(Clone, Copy, Debug)]
pub enum Source {
    PrimaryMonitor,
    /// Índice do monitor, como o Windows enumera (a partir de 1).
    Monitor(usize),
    /// Janela, pelo identificador (HWND).
    Window(isize),
}

#[derive(Clone, Copy, Debug)]
pub struct Quality {
    pub fps: u32,
    /// Teto da taxa de bits, em bits por segundo.
    pub bitrate: u32,
    /// Altura máxima enviada; telas maiores são reduzidas na GPU.
    pub max_height: u32,
}

impl Default for Quality {
    fn default() -> Self {
        Self {
            fps: 60,
            bitrate: 8_000_000,
            max_height: 1080,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub capturing: bool,
    pub viewers: usize,
    pub encoder: String,
    pub target_bitrate: u32,
    pub frames_encoded: usize,
}

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
    Close,
}

/// O que o capturador/codificador e as conexões compartilham.
struct Shared {
    /// Uma fila por espectador: nenhum quadro pode ser pulado, senão a imagem quebra.
    subscribers: Mutex<HashMap<u64, Sender<Msg>>>,
    /// Alguém entrou ou perdeu pacotes: o próximo quadro precisa ser completo.
    keyframe: AtomicBool,
    viewers: AtomicUsize,
    encoded: AtomicUsize,
    encoder: Mutex<String>,
    /// Banda estimada de cada espectador, em bits por segundo.
    estimates: Mutex<HashMap<u64, u64>>,
    /// Taxa de bits que o codificador está usando agora.
    target: AtomicU32,
    next_id: AtomicU64,
    quality: Mutex<Quality>,
    /// A fonte capturada fechou (a janela ou o jogo foi encerrado).
    ended: AtomicBool,
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
            .retain(|_, s| s.send(Msg::Frame(frame.clone())).is_ok());
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
    /// Tamanho da fonte para o qual o codificador foi criado; janela redimensionada recria.
    size: (u32, u32),
    out: Vec<Vec<u8>>,
    checked: Instant,
}

// SAFETY: a captura roda numa única thread (a que a biblioteca de captura cria); os objetos do
// Direct3D e os codificadores nunca são usados por duas threads ao mesmo tempo.
unsafe impl Send for Capture {}

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

impl Capture {
    fn codec_for(&mut self, frame: &Frame) -> Result<(), AnyError> {
        let input = (frame.width(), frame.height());
        if self.codec.is_some() && self.size == input {
            return Ok(());
        }
        let quality = *self.shared.quality.lock().unwrap();
        let scale = f64::from(quality.max_height.min(input.1)) / f64::from(input.1);
        let output = (
            (f64::from(input.0) * scale) as u32,
            (f64::from(input.1) * scale) as u32,
        );
        let bitrate = self.shared.target.load(Ordering::Relaxed);
        let codec = match HwEncoder::new(
            frame.device(),
            frame.device_context(),
            input,
            output,
            quality.fps,
            bitrate,
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
        self.size = input;
        // Codificador novo começa por um quadro completo.
        self.shared.keyframe.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Controle de banda: uma vez por segundo, ajusta a taxa para a conexão mais apertada.
    fn adapt(&mut self) {
        if self.checked.elapsed() < Duration::from_secs(1) {
            return;
        }
        self.checked = Instant::now();
        let ceiling = self.shared.quality.lock().unwrap().bitrate;
        let lowest = self
            .shared
            .estimates
            .lock()
            .unwrap()
            .values()
            .copied()
            .min();
        let Some(lowest) = lowest else { return };
        let wanted = ((lowest * 9 / 10).min(u64::from(u32::MAX)) as u32)
            .clamp(MIN_BITRATE.min(ceiling), ceiling);
        let current = self.shared.target.load(Ordering::Relaxed);
        if wanted.abs_diff(current) > current / 12 {
            self.shared.target.store(wanted, Ordering::Relaxed);
            if let Some(Codec264::Hardware(encoder)) = self.codec.as_mut() {
                encoder.set_bitrate(wanted);
            }
        }
    }
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = Arc<Shared>;
    type Error = AnyError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            shared: ctx.flags,
            codec: None,
            size: (0, 0),
            out: Vec::new(),
            checked: Instant::now(),
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
        self.codec_for(frame)?;
        self.adapt();
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

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.shared.ended.store(true, Ordering::Relaxed);
        Ok(())
    }
}

/// Endereço da máquina na rede local, pela rota padrão.
fn local_ip() -> IpAddr {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("8.8.8.8:80").and_then(|()| s.local_addr()))
        .map_or(IpAddr::from([127, 0, 0, 1]), |a| a.ip())
}

/// Pergunta a um servidor STUN com que endereço público este soquete aparece na internet.
/// É o que permite a conexão direta com quem está fora da rede local.
fn public_address(socket: &UdpSocket) -> Option<SocketAddr> {
    const MAGIC: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];
    // Pedido de "binding": tipo 0x0001, tamanho 0, cookie mágico e 12 bytes de identificação.
    let mut request = [0u8; 20];
    request[1] = 0x01;
    request[4..8].copy_from_slice(&MAGIC);
    let id = Instant::now().elapsed().as_nanos() as u64
        ^ u64::from(std::process::id())
        ^ 0x9E37_79B9_7F4A_7C15;
    request[8..16].copy_from_slice(&id.to_le_bytes());
    request[16..20].copy_from_slice(&(socket.local_addr().ok()?.port() as u32).to_le_bytes());

    socket
        .set_read_timeout(Some(Duration::from_millis(400)))
        .ok()?;
    for server in STUN_SERVERS {
        let Some(target) = server
            .to_socket_addrs()
            .ok()
            .and_then(|mut a| a.find(SocketAddr::is_ipv4))
        else {
            continue;
        };
        if socket.send_to(&request, target).is_err() {
            continue;
        }
        let mut buf = [0u8; 512];
        let Ok((n, from)) = socket.recv_from(&mut buf) else {
            continue;
        };
        // Só vale a resposta do servidor perguntado, com a mesma identificação.
        if from != target || n < 20 || buf[0..2] != [0x01, 0x01] || buf[8..20] != request[8..20] {
            continue;
        }
        let mut i = 20;
        while i + 4 <= n {
            let kind = u16::from_be_bytes([buf[i], buf[i + 1]]);
            let len = usize::from(u16::from_be_bytes([buf[i + 2], buf[i + 3]]));
            let value = i + 4;
            if value + len > n {
                break;
            }
            // XOR-MAPPED-ADDRESS, IPv4: porta e endereço vêm embaralhados com o cookie mágico.
            if kind == 0x0020 && len >= 8 && buf[value + 1] == 0x01 {
                let port = u16::from_be_bytes([buf[value + 2], buf[value + 3]]) ^ 0x2112;
                let ip = [
                    buf[value + 4] ^ MAGIC[0],
                    buf[value + 5] ^ MAGIC[1],
                    buf[value + 6] ^ MAGIC[2],
                    buf[value + 7] ^ MAGIC[3],
                ];
                return Some(SocketAddr::new(IpAddr::from(ip), port));
            }
            i = value + len.div_ceil(4) * 4;
        }
    }
    None
}

pub struct Engine {
    shared: Arc<Shared>,
    control: Mutex<Option<CaptureControl<Capture, AnyError>>>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Self {
        static CRYPTO: Once = Once::new();
        CRYPTO.call_once(|| str0m::crypto::from_feature_flags().install_process_default());
        let quality = Quality::default();
        let shared = Arc::new(Shared {
            subscribers: Mutex::default(),
            keyframe: AtomicBool::new(false),
            viewers: AtomicUsize::new(0),
            encoded: AtomicUsize::new(0),
            encoder: Mutex::default(),
            estimates: Mutex::default(),
            target: AtomicU32::new(quality.bitrate),
            next_id: AtomicU64::new(1),
            quality: Mutex::new(quality),
            ended: AtomicBool::new(false),
        });
        Self {
            shared,
            control: Mutex::new(None),
        }
    }

    /// Começa a capturar. Trocar de fonte é parar e começar de novo; os espectadores continuam
    /// conectados e recebem a fonte nova.
    pub fn start(&self, source: Source, quality: Quality) -> Result<(), AnyError> {
        self.stop_capture();
        *self.shared.quality.lock().unwrap() = quality;
        self.shared.target.store(quality.bitrate, Ordering::Relaxed);
        self.shared.ended.store(false, Ordering::Relaxed);
        let control = match source {
            Source::PrimaryMonitor => self.launch(Monitor::primary()?, quality)?,
            Source::Monitor(index) => self.launch(Monitor::from_index(index)?, quality)?,
            Source::Window(hwnd) => {
                let window = Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void);
                if !window.is_valid() {
                    return Err("essa janela não pode ser capturada (fechada ou invisível)".into());
                }
                self.launch(window, quality)?
            }
        };
        *self.control.lock().unwrap() = Some(control);
        Ok(())
    }

    fn launch<T>(
        &self,
        item: T,
        quality: Quality,
    ) -> Result<CaptureControl<Capture, AnyError>, AnyError>
    where
        T: TryInto<GraphicsCaptureItemType> + Send + 'static,
    {
        let settings = Settings::new(
            item,
            CursorCaptureSettings::Default,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(Duration::from_micros(
                1_000_000 / u64::from(quality.fps.max(1)),
            )),
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            self.shared.clone(),
        );
        Capture::start_free_threaded(settings).map_err(|e| format!("captura falhou: {e}").into())
    }

    fn stop_capture(&self) {
        if let Some(control) = self.control.lock().unwrap().take() {
            let _ = control.stop();
        }
    }

    /// Para a captura e desconecta todo mundo.
    pub fn stop(&self) {
        self.stop_capture();
        for (_, viewer) in self.shared.subscribers.lock().unwrap().drain() {
            let _ = viewer.send(Msg::Close);
        }
        self.shared.encoder.lock().unwrap().clear();
    }

    /// Aceita a oferta WebRTC de um espectador (JSON `{type, sdp}`) e devolve o identificador da
    /// conexão e a resposta (JSON `{type, sdp}`), já com os endereços por onde ele pode chegar.
    pub fn accept(&self, offer: &[u8]) -> Result<(u64, Vec<u8>), AnyError> {
        let offer: SdpOffer = serde_json::from_slice(offer)?;
        let ceiling = self.shared.quality.lock().unwrap().bitrate;
        let mut rtc = RtcConfig::new()
            .enable_bwe(Some(Bitrate::bps(u64::from(ceiling) / 2)))
            .build(Instant::now());

        let socket = UdpSocket::bind("0.0.0.0:0")?;
        let local = SocketAddr::new(local_ip(), socket.local_addr()?.port());
        rtc.add_local_candidate(Candidate::host(local, "udp")?);
        if let Some(public) = public_address(&socket)
            && public != local
            && let Ok(candidate) = Candidate::server_reflexive(public, local, "udp")
        {
            rtc.add_local_candidate(candidate);
        }
        let answer = serde_json::to_vec(&rtc.sdp_api().accept_offer(offer)?)?;

        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, inbox) = channel();
        self.shared
            .subscribers
            .lock()
            .unwrap()
            .insert(id, sender.clone());

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
                            ErrorKind::WouldBlock
                                | ErrorKind::TimedOut
                                | ErrorKind::ConnectionReset
                        ) =>
                    {
                        // O aviso de porta fechada volta na hora e sem parar: espera um pouco para
                        // não girar à toa. Depois acorda a conexão para ela notar que acabou.
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

        let shared = self.shared.clone();
        std::thread::spawn(move || {
            shared.viewers.fetch_add(1, Ordering::Relaxed);
            if let Err(e) = viewer(rtc, &socket, local, &shared, &inbox, id) {
                eprintln!("espectador {id}: {e}");
            }
            shared.subscribers.lock().unwrap().remove(&id);
            shared.estimates.lock().unwrap().remove(&id);
            shared.viewers.fetch_sub(1, Ordering::Relaxed);
        });
        Ok((id, answer))
    }

    /// Encerra a conexão de um espectador.
    pub fn close(&self, viewer: u64) {
        if let Some(sender) = self.shared.subscribers.lock().unwrap().remove(&viewer) {
            let _ = sender.send(Msg::Close);
        }
    }

    pub fn stats(&self) -> Stats {
        Stats {
            capturing: self
                .control
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|c| !c.is_finished())
                && !self.shared.ended.load(Ordering::Relaxed),
            viewers: self.shared.viewers.load(Ordering::Relaxed),
            encoder: self.shared.encoder.lock().unwrap().clone(),
            target_bitrate: self.shared.target.load(Ordering::Relaxed),
            frames_encoded: self.shared.encoded.load(Ordering::Relaxed),
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Uma conexão de espectador: só repassa os quadros que o codificador único produziu. Dorme até
/// chegar um quadro, um pacote da rede ou a hora que o WebRTC pediu.
fn viewer(
    mut rtc: Rtc,
    socket: &UdpSocket,
    local: SocketAddr,
    shared: &Shared,
    inbox: &Receiver<Msg>,
    id: u64,
) -> Result<(), AnyError> {
    let start = Instant::now();
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
                        connected = true;
                        shared.keyframe.store(true, Ordering::Relaxed);
                        let target = u64::from(shared.target.load(Ordering::Relaxed));
                        let ceiling = u64::from(shared.quality.lock().unwrap().bitrate);
                        rtc.bwe()
                            .set_bitrate(Bitrate::bps(target), Bitrate::bps(ceiling * 3 / 2));
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
        let message = if wait.is_zero() {
            None
        } else {
            inbox.recv_timeout(wait).ok()
        };
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
            Some(Msg::Close) => return Ok(()),
            Some(Msg::Tick) | None => rtc.handle_input(Input::Timeout(Instant::now()))?,
        }
    }
}
