// Avisos sonoros curtos, sintetizados na hora (sem arquivos de áudio). Cada evento tem um desenho
// próprio: entrada sobe, saída desce e live nova toca um arpejo.
export type RoomSound = 'join' | 'leave' | 'live';

const NOTES: Record<RoomSound, Array<[frequency: number, start: number, length: number]>> = {
  join: [
    [659.25, 0, 0.12],
    [987.77, 0.09, 0.2],
  ],
  leave: [
    [587.33, 0, 0.12],
    [392.0, 0.09, 0.22],
  ],
  live: [
    [523.25, 0, 0.1],
    [659.25, 0.08, 0.1],
    [783.99, 0.16, 0.1],
    [1046.5, 0.24, 0.28],
  ],
};

const STORAGE_KEY = 'nimbo.sounds';
let context: AudioContext | null = null;
let lastPlayed = 0;

export function soundsEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundsEnabled(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Sem armazenamento: vale só nesta sessão.
  }
}

export function playSound(sound: RoomSound) {
  if (!soundsEnabled()) return;
  // Vários eventos juntos (ex.: alguém entra já transmitindo) viram um som só.
  const now = performance.now();
  if (now - lastPlayed < 250) return;
  lastPlayed = now;
  try {
    context ??= new AudioContext();
    void context.resume();
    const t0 = context.currentTime + 0.02;
    const out = context.createGain();
    out.gain.value = 0.16;
    out.connect(context.destination);
    for (const [frequency, start, length] of NOTES[sound]) {
      const osc = context.createOscillator();
      const env = context.createGain();
      osc.type = 'triangle';
      osc.frequency.value = frequency;
      env.gain.setValueAtTime(0, t0 + start);
      env.gain.linearRampToValueAtTime(1, t0 + start + 0.012);
      env.gain.exponentialRampToValueAtTime(0.001, t0 + start + length);
      osc.connect(env).connect(out);
      osc.start(t0 + start);
      osc.stop(t0 + start + length + 0.05);
    }
  } catch {
    // Sem Web Audio: segue sem som.
  }
}
