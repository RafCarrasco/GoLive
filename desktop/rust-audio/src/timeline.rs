//! Relógio do fluxo: quanto silêncio falta para o som acompanhar o tempo real.
//!
//! O process loopback tem buracos: o Windows para de entregar pacotes quando o alvo começa ou
//! para de tocar e quando nada toca. Sem isto, o fluxo "encolheria" a cada buraco e o som sairia
//! adiantado em relação ao vídeo. Regra: enquanto chegam
//! pacotes, quem manda é o dispositivo (nada é inserido, nem para corrigir relógios que andam em
//! ritmos diferentes); calado há mais de [`IDLE`], o fluxo anda pelo relógio do computador, um
//! período atrás dele, como o dispositivo faria. A posição volta a bater com o relógio a cada
//! pausa, então o erro não se acumula.

use std::time::Duration;

use crate::SAMPLE_RATE;

const fn frames(ms: u64) -> u64 {
    ms * SAMPLE_RATE as u64 / 1000
}

/// Um período do dispositivo. O som capturado chega com esse atraso, então o silêncio para um
/// período antes do relógio para não passar por cima do som que ainda vai chegar.
const PERIOD: u64 = frames(10);
/// Sem pacote há este tempo, o alvo está calado. Menos que isso é só atraso de entrega.
const IDLE: Duration = Duration::from_millis(30);
/// Buraco maior que isto (computador suspenso, `on_pcm` travado) é pulado, não preenchido: quem
/// recebe não quer minutos de silêncio de uma vez.
const MAX_GAP: u64 = frames(1000);

fn frames_at(elapsed: Duration) -> u64 {
    (elapsed.as_micros() * u128::from(SAMPLE_RATE) / 1_000_000) as u64
}

#[derive(Default)]
pub(crate) struct Timeline {
    /// Quadros já entregues (som + silêncio).
    pub emitted: u64,
    /// Quanto disso foi silêncio inserido por nós.
    pub filled: u64,
    /// Tempo pulado em buracos grandes, descontado do relógio.
    skipped: u64,
    last_packet: Duration,
}

impl Timeline {
    /// Chegou um pacote do Windows com `count` quadros.
    pub fn packet(&mut self, now: Duration, count: u64) {
        self.emitted += count;
        self.last_packet = now;
    }

    /// Quantos quadros de silêncio entregar agora (já contados em `emitted`).
    pub fn silence_due(&mut self, now: Duration) -> u64 {
        if now.saturating_sub(self.last_packet) < IDLE {
            return 0;
        }
        let due = frames_at(now).saturating_sub(self.skipped);
        let behind = due.saturating_sub(self.emitted + PERIOD);
        if behind < PERIOD {
            return 0;
        }
        if behind > MAX_GAP {
            self.skipped += behind;
            return 0;
        }
        self.emitted += behind;
        self.filled += behind;
        behind
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn silence_follows_the_clock() {
        let mut timeline = Timeline::default();
        // 15 ms: o intervalo real do temporizador do Windows, que não é múltiplo do período.
        for tick in (15..=5000).step_by(15) {
            timeline.silence_due(ms(tick));
        }
        let behind = frames(4995) - timeline.emitted;
        assert!((PERIOD..2 * PERIOD).contains(&behind), "{behind}");
        assert_eq!(timeline.filled, timeline.emitted);
    }

    #[test]
    fn continuous_sound_is_never_padded() {
        let mut timeline = Timeline::default();
        // Dispositivo 2% mais lento que o relógio: a diferença cresce, mas não vira silêncio.
        for tick in (10..=60_000).step_by(10) {
            assert_eq!(timeline.silence_due(ms(tick)), 0);
            timeline.packet(ms(tick), 470);
        }
        assert_eq!(timeline.filled, 0);
    }

    #[test]
    fn pause_is_filled_and_position_returns_to_the_clock() {
        let mut timeline = Timeline::default();
        for tick in (10..=1000).step_by(10) {
            timeline.silence_due(ms(tick));
            timeline.packet(ms(tick), 470);
        }
        for tick in (1010..=2000).step_by(10) {
            timeline.silence_due(ms(tick));
        }
        // O som volta: o pacote que chega em 2010 ms foi capturado a partir de 2000 ms.
        timeline.silence_due(ms(2010));
        let error = frames(2000).abs_diff(timeline.emitted);
        assert!(error < PERIOD, "{error}");
        // O atraso acumulado enquanto tocava (10 quadros por pacote) também foi coberto.
        assert!(timeline.filled > frames(990));
    }

    #[test]
    fn huge_gap_is_skipped() {
        let mut timeline = Timeline::default();
        timeline.silence_due(ms(100));
        let before = timeline.emitted;
        // Uma hora parado (suspensão): nada de uma hora de silêncio.
        assert_eq!(timeline.silence_due(ms(3_600_000)), 0);
        assert_eq!(timeline.emitted, before);
        // Depois disso o fluxo segue normalmente.
        assert_eq!(timeline.silence_due(ms(3_600_020)), frames(20));
    }
}
