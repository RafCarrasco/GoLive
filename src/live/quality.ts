// Qualidade automática por conexão: cada amigo que assiste tem a sua própria conexão (e o seu
// próprio codificador), então a qualidade é ajustada para cada um conforme a rede dele.
// Nível 0 = configuração escolhida; 1 = intermediário; 2 = econômico.
export type QualityLevel = 0 | 1 | 2;

export const LEVELS: Record<QualityLevel, { bitrate: number; scale: number; maxFps?: number }> = {
  0: { bitrate: 1, scale: 1 },
  1: { bitrate: 0.6, scale: 1.5 },
  2: { bitrate: 0.35, scale: 2, maxFps: 30 },
};

export type QualityState = { level: QualityLevel; bad: number; good: number };
export type QualitySample = {
  // Fração de pacotes perdidos que o outro lado relatou (0 a 1).
  loss: number;
  // O codificador está segurando a qualidade por falta de banda (qualityLimitationReason).
  limited: boolean;
  // Banda estimada para envio do vídeo desta live, em bits por segundo (0 se desconhecida).
  available: number;
  // Teto de bitrate do nível atual, em bits por segundo.
  current: number;
};

// Desce rápido (duas medições ruins, ~6 s) e sobe devagar (cinco boas, ~15 s) para não ficar
// oscilando. Retorna o novo estado.
export function nextQuality(state: QualityState, s: QualitySample): QualityState {
  // A banda estimada só pesa quando o codificador está de fato limitado por ela: uma tela parada
  // usa pouco e a estimativa fica baixa sem haver problema nenhum.
  const congested = s.loss > 0.05 || (s.limited && s.available > 0 && s.available < s.current * 0.7);
  const roomy = s.loss < 0.01 && !s.limited;
  if (congested) {
    const bad = state.bad + 1;
    if (bad >= 2 && state.level < 2) return { level: (state.level + 1) as QualityLevel, bad: 0, good: 0 };
    return { ...state, bad, good: 0 };
  }
  if (roomy && state.level > 0) {
    const good = state.good + 1;
    if (good >= 5) return { level: (state.level - 1) as QualityLevel, bad: 0, good: 0 };
    return { ...state, bad: 0, good };
  }
  return { ...state, bad: 0, good: 0 };
}
