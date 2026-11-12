//! Só para testar a captura sem fazer barulho: toca um tom que ninguém ouve e sai.
//!
//!   cargo run --release --example quiet_tone -- [segundos]
//!
//! O tom tem 20 Hz e 8 passos de 32768 de amplitude (-72 dBFS): fica dezenas de decibéis abaixo
//! do que o ouvido percebe nessa frequência, em qualquer volume, mas é som de verdade para o
//! Windows. Com `nimbo-audio include <pid>` ele aparece (pico perto de 0.00024); com
//! `exclude <pid>` some. Escreve `READY <pid>` quando começa a tocar.

use std::f64::consts::TAU;
use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Media::Audio::{
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_NOPERSIST,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, IAudioClient, IAudioRenderClient, IMMDeviceEnumerator,
    MMDeviceEnumerator, WAVE_FORMAT_PCM, WAVEFORMATEX, eConsole, eRender,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
};

const RATE: u32 = 48_000;
const HERTZ: f64 = 20.0;
const AMPLITUDE: f64 = 8.0;

fn play(seconds: u64) -> windows::core::Result<()> {
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: 2,
        nSamplesPerSec: RATE,
        nAvgBytesPerSec: RATE * 4,
        nBlockAlign: 4,
        wBitsPerSample: 16,
        cbSize: 0,
    };
    let flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
        | AUDCLNT_STREAMFLAGS_NOPERSIST;
    // SAFETY: sequência padrão do WASAPI numa thread só; `format` vive durante o Initialize e os
    // objetos COM são soltos antes de o processo sair.
    let (client, render, capacity) = unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        // Fila de 100 ms.
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1_000_000, 0, &format, None)?;
        let render: IAudioRenderClient = client.GetService()?;
        let capacity = client.GetBufferSize()?;
        client.Start()?;
        (client, render, capacity)
    };
    println!("READY {}", std::process::id());

    let started = Instant::now();
    let mut position = 0u64;
    while started.elapsed() < Duration::from_secs(seconds) {
        // SAFETY: o GetBuffer entrega espaço para `free` quadros de 4 bytes, válido até o
        // ReleaseBuffer; a fatia não sai deste bloco.
        unsafe {
            let free = capacity - client.GetCurrentPadding()?;
            if free > 0 {
                let data = render.GetBuffer(free)?;
                let samples = std::slice::from_raw_parts_mut(data.cast::<i16>(), free as usize * 2);
                for frame in samples.as_chunks_mut::<2>().0 {
                    let phase = TAU * HERTZ * position as f64 / f64::from(RATE);
                    frame.fill((AMPLITUDE * phase.sin()).round() as i16);
                    position += 1;
                }
                render.ReleaseBuffer(free, 0)?;
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    // SAFETY: chamada COM simples.
    unsafe { client.Stop() }
}

fn main() {
    let seconds = std::env::args()
        .nth(1)
        .and_then(|text| text.parse().ok())
        .unwrap_or(5);
    if let Err(error) = play(seconds) {
        eprintln!("ERROR {error}");
        std::process::exit(1);
    }
}
