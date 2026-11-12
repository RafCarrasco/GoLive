//! `nimbo-media hw [segundos] [largura] [altura] [fps]`: captura + codificação pela placa direto na
//! GPU. Grava um .h264 e imprime quadros por segundo e CPU.

use std::io::Write;
use std::time::{Duration, Instant};

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

pub struct Job {
    pub seconds: u64,
    pub input: (u32, u32),
    pub output: (u32, u32),
    pub fps: u32,
    pub path: String,
}

struct Bench {
    job: Job,
    encoder: Option<HwEncoder>,
    file: std::fs::File,
    start: Instant,
    cpu_start: Duration,
    captured: u64,
    accepted: u64,
    encoded: u64,
    bytes: u64,
    encode_time: Duration,
    out: Vec<Vec<u8>>,
    /// Bytes produzidos na primeira metade (8 Mbps); na segunda a taxa cai para 2 Mbps.
    first_half: Option<u64>,
}

impl GraphicsCaptureApiHandler for Bench {
    type Flags = Job;
    type Error = AnyError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let file = std::fs::File::create(&ctx.flags.path)?;
        Ok(Self {
            job: ctx.flags,
            encoder: None,
            file,
            start: Instant::now(),
            cpu_start: crate::process_cpu(),
            captured: 0,
            accepted: 0,
            encoded: 0,
            bytes: 0,
            encode_time: Duration::ZERO,
            out: Vec::new(),
            first_half: None,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        self.captured += 1;
        if self.encoder.is_none() {
            let encoder = HwEncoder::new(
                frame.device(),
                frame.device_context(),
                self.job.input,
                self.job.output,
                self.job.fps,
                8_000_000,
            )?;
            eprintln!(
                "codificador: {} ({}x{})",
                encoder.name, encoder.width, encoder.height
            );
            self.encoder = Some(encoder);
        }
        let encoder = self.encoder.as_mut().unwrap();
        let t = Instant::now();
        let first = self.accepted == 0;
        if encoder.encode(frame.as_raw_texture(), first, &mut self.out)? {
            self.accepted += 1;
        }
        self.encode_time += t.elapsed();
        for data in self.out.drain(..) {
            self.encoded += 1;
            self.bytes += data.len() as u64;
            self.file.write_all(&data)?;
        }
        let elapsed = self.start.elapsed();
        // Na metade do teste, troca a taxa com o codificador rodando (é o que o controle de banda faz).
        if self.first_half.is_none() && elapsed.as_secs() >= self.job.seconds / 2 {
            self.first_half = Some(self.bytes);
            if let Some(encoder) = self.encoder.as_mut() {
                encoder.set_bitrate(2_000_000);
            }
        }
        if elapsed.as_secs() >= self.job.seconds {
            let cpu = crate::process_cpu().saturating_sub(self.cpu_start);
            let secs = elapsed.as_secs_f64();
            println!(
                "{{\"modo\":\"hw\",\"saida\":\"{}x{}\",\"capturados_fps\":{:.1},\"codificados_fps\":{:.1},\"descartados\":{},\"mbps_8\":{:.2},\"mbps_depois_de_pedir_2\":{:.2},\"cpu_um_nucleo_pct\":{:.1},\"ms_por_quadro\":{:.3}}}",
                self.job.output.0,
                self.job.output.1,
                self.captured as f64 / secs,
                self.encoded as f64 / secs,
                self.captured - self.accepted,
                self.first_half.unwrap_or(0) as f64 * 8.0 / (secs / 2.0) / 1e6,
                (self.bytes - self.first_half.unwrap_or(0)) as f64 * 8.0 / (secs / 2.0) / 1e6,
                cpu.as_secs_f64() / secs * 100.0,
                self.encode_time.as_secs_f64() * 1000.0 / self.captured.max(1) as f64,
            );
            control.stop();
        }
        Ok(())
    }
}

pub fn run(args: &[String]) -> Result<(), AnyError> {
    let arg = |i: usize| args.get(i).and_then(|s| s.parse::<u32>().ok());
    let monitor = Monitor::primary()?;
    let input = (monitor.width()?, monitor.height()?);
    let job = Job {
        seconds: u64::from(arg(1).unwrap_or(10)),
        input,
        output: (arg(2).unwrap_or(input.0), arg(3).unwrap_or(input.1)),
        fps: arg(4).unwrap_or(60),
        path: args
            .get(5)
            .cloned()
            .unwrap_or_else(|| "nimbo-media.h264".into()),
    };
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::Default,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Custom(Duration::from_micros(16_666)),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        job,
    );
    Bench::start(settings).map_err(|e| format!("captura falhou: {e}"))?;
    Ok(())
}
