//! Áudio do jogo: captura o som do Windows por processo (WASAPI process loopback, Windows 10
//! 2004+), no lugar do auxiliar em C# (`desktop/native/NimboAudio.cs`).
//!
//! Dois modos, os mesmos do auxiliar: [`Mode::Include`] pega só um processo e seus filhos (o
//! jogo); [`Mode::Exclude`] pega tudo menos um processo e seus filhos (o próprio Nimbo, para a
//! live não recapturar o que toca nele).
//!
//! O formato é o mesmo do auxiliar: PCM de 16 bits, little-endian, 48 kHz, estéreo intercalado.
//!
//! Diferente do auxiliar, o fluxo é contínuo. O Windows para de entregar pacotes em alguns
//! momentos (medido: 30 a 50 ms cada vez que o alvo começa ou para de tocar; e, pela documentação
//! da API, enquanto nada toca no computador). O auxiliar simplesmente pulava esse tempo; aqui ele
//! vira silêncio, preenchido pelo relógio (ver `timeline.rs`). Assim o tempo de um trecho é só a
//! posição dele: `quadro / 48000` segundos desde o início.
//!
//! O silêncio que vem do Windows não é zero puro: a conversão para 16 bits deixa um ruído de ±1
//! (igual no auxiliar). O silêncio preenchido aqui é zero.

mod timeline;

use std::fmt;
use std::mem::ManuallyDrop;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, ActivateAudioInterfaceAsync,
    IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVE_FORMAT_PCM, WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{BLOB, COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW, SetEvent,
    WaitForMultipleObjects,
};
use windows::Win32::System::Variant::VT_BLOB;
use windows::core::{HRESULT, Interface, Ref, implement, w};

use timeline::Timeline;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;
pub const BITS_PER_SAMPLE: u16 = 16;
/// Bytes de um quadro (uma amostra de cada canal).
pub const FRAME_BYTES: usize = 4;

/// Fila pedida ao Windows, em unidades de 100 ns (20 ms, igual ao auxiliar).
const BUFFER_HNS: i64 = 200_000;
/// Mesmo sem aviso do Windows a thread acorda neste intervalo, para o silêncio andar.
const TICK_MS: u32 = 10;
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(5);
/// Bloco de zeros reaproveitado para entregar silêncio (100 ms).
static SILENCE: [u8; SAMPLE_RATE as usize / 10 * FRAME_BYTES] =
    [0; SAMPLE_RATE as usize / 10 * FRAME_BYTES];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Só o som deste processo e dos filhos dele.
    Include(u32),
    /// Todo o som do computador, menos o deste processo e dos filhos dele.
    Exclude(u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Uma chamada do Windows falhou: `step` diz qual e `code` é o HRESULT.
    Windows { step: &'static str, code: i32 },
    /// O Windows não respondeu ao pedido de ativação.
    ActivationTimeout,
    /// A thread de captura não pôde ser criada ou caiu (pânico dentro do `on_pcm`).
    Thread,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Windows { step, code } => write!(f, "{step} 0x{code:08X}"),
            Self::ActivationTimeout => f.write_str("ativação expirou"),
            Self::Thread => f.write_str("a thread de captura caiu"),
        }
    }
}

impl std::error::Error for Error {}

fn win(step: &'static str) -> impl Fn(windows::core::Error) -> Error {
    move |error| Error::Windows {
        step,
        code: error.code().0,
    }
}

/// O que a captura entregou até parar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    /// Quadros entregues ao `on_pcm` (som + silêncio).
    pub frames: u64,
    /// Quantos deles foram silêncio preenchido aqui, porque o Windows não entregou nada.
    pub silence_frames: u64,
}

struct Event(HANDLE);

// SAFETY: um evento do Windows é um objeto do núcleo; sinalizar, esperar e fechar pelo handle
// vale de qualquer thread.
unsafe impl Send for Event {}
// SAFETY: idem; as funções usadas aqui não exigem acesso exclusivo.
unsafe impl Sync for Event {}

impl Event {
    fn new(manual_reset: bool) -> Result<Self, Error> {
        // SAFETY: sem atributos de segurança e sem nome; os dois ponteiros podem ser nulos.
        unsafe { CreateEventW(None, manual_reset, false, None) }
            .map(Self)
            .map_err(win("CreateEvent"))
    }

    fn set(&self) {
        // SAFETY: o handle é válido enquanto `self` existir.
        let _ = unsafe { SetEvent(self.0) };
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: o handle veio do CreateEventW e é fechado uma única vez, aqui.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// Uma captura em andamento. Para ao chamar [`Capture::stop`] ou ao ser descartada.
pub struct Capture {
    stop: Arc<Event>,
    thread: Option<JoinHandle<Result<Stats, Error>>>,
}

impl Capture {
    /// Começa a capturar e só volta quando o som já está correndo (ou com o erro).
    ///
    /// `on_pcm` roda na thread de captura e recebe um número inteiro de quadros por vez; precisa
    /// ser rápido (copiar, enfileirar), senão a fila do Windows estoura e o som falha.
    ///
    /// Um PID que não existe não é erro para o Windows: a captura começa e entrega silêncio. O
    /// mesmo vale quando o processo fecha no meio; quem decide o fim da live é o vigia do jogo.
    pub fn start(mode: Mode, on_pcm: impl FnMut(&[u8]) + Send + 'static) -> Result<Self, Error> {
        let stop = Arc::new(Event::new(true)?);
        let (ready, started) = mpsc::channel();
        let thread_stop = Arc::clone(&stop);
        let thread = thread::Builder::new()
            .name("nimbo-audio".into())
            .spawn(move || run(mode, &thread_stop, ready, on_pcm))
            .map_err(|_| Error::Thread)?;
        match started.recv() {
            Ok(()) => Ok(Self {
                stop,
                thread: Some(thread),
            }),
            // A thread saiu sem avisar que começou: o motivo é o que ela devolveu.
            Err(_) => Err(match thread.join() {
                Ok(Err(error)) => error,
                _ => Error::Thread,
            }),
        }
    }

    /// `false` quando a captura morreu sozinha (erro do Windows); [`Capture::stop`] diz por quê.
    pub fn is_running(&self) -> bool {
        self.thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
    }

    /// Para a captura e espera a thread sair. Depois disso o `on_pcm` não é mais chamado.
    pub fn stop(mut self) -> Result<Stats, Error> {
        self.join()
    }

    fn join(&mut self) -> Result<Stats, Error> {
        self.stop.set();
        match self.thread.take() {
            Some(thread) => thread.join().unwrap_or(Err(Error::Thread)),
            None => Err(Error::Thread),
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if self.thread.is_some() {
            let _ = self.join();
        }
    }
}

/// Avisa a thread de captura que o Windows terminou de ativar o cliente de áudio.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Activated(mpsc::Sender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}

fn run(
    mode: Mode,
    stop: &Event,
    ready: mpsc::Sender<()>,
    mut on_pcm: impl FnMut(&[u8]),
) -> Result<Stats, Error> {
    // SAFETY: primeira chamada COM desta thread, que é só nossa; o par é o CoUninitialize abaixo.
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(win("CoInitializeEx"))?;
    let result = session(mode, stop, ready, &mut on_pcm);
    // SAFETY: par do CoInitializeEx acima; os objetos COM já foram soltos dentro de `session`.
    unsafe { CoUninitialize() };
    result
}

fn activate(mode: Mode) -> Result<IAudioClient, Error> {
    let (pid, tree) = match mode {
        Mode::Include(pid) => (pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE),
        Mode::Exclude(pid) => (pid, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE),
    };
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: tree,
            },
        },
    };
    // Sem o ManuallyDrop, a PROPVARIANT tentaria liberar o blob ao sair, e ele mora na pilha.
    let mut variant = ManuallyDrop::new(PROPVARIANT::default());
    // SAFETY: PROPVARIANT recém-zerada; escrevemos o tipo e o campo que corresponde a ele. O blob
    // aponta para `params`, que vive até o fim desta função.
    unsafe {
        let inner = &mut *variant.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob = BLOB {
            cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: (&raw const params).cast_mut().cast(),
        };
    }
    let (done, completed) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Activated(done).into();
    // SAFETY: o caminho é uma constante terminada em zero, o IID e a PROPVARIANT são referências
    // válidas durante a chamada e o Windows guarda a própria referência ao `handler`.
    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*variant),
            &handler,
        )
    }
    .map_err(win("ativação"))?;
    if completed.recv_timeout(ACTIVATION_TIMEOUT).is_err() {
        return Err(Error::ActivationTimeout);
    }
    let mut result = HRESULT(0);
    let mut client = None;
    // SAFETY: os dois ponteiros apontam para variáveis locais; a ativação já terminou.
    unsafe { operation.GetActivateResult(&mut result, &mut client) }.map_err(win("ativação"))?;
    result.ok().map_err(win("ativação"))?;
    client
        .ok_or(Error::Windows {
            step: "ativação",
            code: result.0,
        })?
        .cast()
        .map_err(win("ativação"))
}

fn session(
    mode: Mode,
    stop: &Event,
    ready: mpsc::Sender<()>,
    on_pcm: &mut impl FnMut(&[u8]),
) -> Result<Stats, Error> {
    // Criado antes do cliente para ser solto depois dele: o Windows usa o evento até o fim.
    let arrived = Event::new(false)?;
    let client = activate(mode)?;
    let block = CHANNELS * BITS_PER_SAMPLE / 8;
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: CHANNELS,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * u32::from(block),
        nBlockAlign: block,
        wBitsPerSample: BITS_PER_SAMPLE,
        cbSize: 0,
    };
    // O dispositivo virtual não tem formato próprio: o Windows converte para o que pedimos.
    let flags = AUDCLNT_STREAMFLAGS_LOOPBACK
        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    // SAFETY: `format` é uma estrutura local válida durante a chamada.
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            flags,
            BUFFER_HNS,
            0,
            &format,
            None,
        )
    }
    .map_err(win("Initialize"))?;
    // SAFETY: `arrived` vive mais que `client` (declarado antes, solto depois).
    unsafe { client.SetEventHandle(arrived.0) }.map_err(win("SetEventHandle"))?;
    // SAFETY: chamada COM simples num cliente já inicializado.
    let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(win("GetService"))?;
    // SAFETY: idem.
    unsafe { client.Start() }.map_err(win("Start"))?;
    let _ = ready.send(());

    // Prioridade de áudio: um jogo usando todos os núcleos não pode atrasar esta thread.
    let mut task = 0;
    // SAFETY: nome constante terminado em zero e ponteiro para variável local.
    let priority = unsafe { AvSetMmThreadCharacteristicsW(w!("Audio"), &mut task) }.ok();
    let result = pump(&capture, stop, &arrived, on_pcm);
    if let Some(priority) = priority {
        // SAFETY: handle devolvido pelo AvSetMmThreadCharacteristicsW nesta mesma thread.
        let _ = unsafe { AvRevertMmThreadCharacteristics(priority) };
    }
    // SAFETY: chamada COM simples; se falhar não há o que fazer, a captura está acabando.
    let _ = unsafe { client.Stop() };
    result
}

fn silence(frames: u64, on_pcm: &mut impl FnMut(&[u8])) {
    let mut bytes = frames as usize * FRAME_BYTES;
    while bytes > 0 {
        let chunk = bytes.min(SILENCE.len());
        on_pcm(&SILENCE[..chunk]);
        bytes -= chunk;
    }
}

fn pump(
    capture: &IAudioCaptureClient,
    stop: &Event,
    arrived: &Event,
    on_pcm: &mut impl FnMut(&[u8]),
) -> Result<Stats, Error> {
    let handles = [stop.0, arrived.0];
    let started = Instant::now();
    let mut timeline = Timeline::default();
    loop {
        // SAFETY: os dois handles pertencem a eventos vivos durante toda a função.
        let wait = unsafe { WaitForMultipleObjects(&handles, false, TICK_MS) };
        if wait == WAIT_OBJECT_0 {
            break;
        }
        if wait == WAIT_FAILED {
            return Err(win("WaitForMultipleObjects")(
                windows::core::Error::from_thread(),
            ));
        }
        silence(timeline.silence_due(started.elapsed()), on_pcm);
        loop {
            // SAFETY: chamada COM simples.
            let pending =
                unsafe { capture.GetNextPacketSize() }.map_err(win("GetNextPacketSize"))?;
            if pending == 0 {
                break;
            }
            let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0, 0);
            // SAFETY: os ponteiros apontam para variáveis locais.
            unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
                .map_err(win("GetBuffer"))?;
            if frames == 0 {
                // Fila vazia apesar do aviso: nada a entregar, e não conta como pacote.
            } else if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                silence(u64::from(frames), on_pcm);
            } else {
                // SAFETY: o Windows garante `frames` quadros em `data` até o ReleaseBuffer abaixo.
                on_pcm(unsafe { std::slice::from_raw_parts(data, frames as usize * FRAME_BYTES) });
            }
            // SAFETY: devolve exatamente o que o GetBuffer entregou.
            unsafe { capture.ReleaseBuffer(frames) }.map_err(win("ReleaseBuffer"))?;
            if frames == 0 {
                break;
            }
            timeline.packet(started.elapsed(), u64::from(frames));
        }
    }
    Ok(Stats {
        frames: timeline.emitted,
        silence_frames: timeline.filled,
    })
}
