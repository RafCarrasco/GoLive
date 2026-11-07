// Ponte com o app Nimbo para Windows (desktop/preload.cjs). No navegador `desktop` é undefined.
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

type DesktopBridge = {
  version: number;
  signIn(): Promise<Result<{ idToken: string; accessToken: string }>>;
  cancelSignIn(): Promise<void>;
  setCaptureAudio(wanted: boolean): Promise<void>;
  startAudio(): Promise<Result<{ id: string; label: string } | null>>;
  stopAudio(id: string): Promise<void>;
  onAudio(id: string, onData: (chunk: Uint8Array) => void, onEnd: (error: string) => void): () => void;
  // A partir do app 0.3.2: aviso de atualização baixada, mostrado pelo site.
  watchUpdate?(onReady: (info: { version: string }) => void): Promise<Result<{ version: string } | null>>;
  installUpdate?(): Promise<void>;
  // A partir do app 0.3.8: progresso do download da atualização (0 a 100).
  onUpdateProgress?(onProgress: (percent: number) => void): () => void;
  // A partir do app 0.3.4: avisa quando o jogo transmitido sai ou volta para a frente.
  startGameWatch?(): Promise<Result<{ id: string; label: string } | null>>;
  stopGameWatch?(id: string): Promise<void>;
  onGameState?(id: string, onChange: (active: boolean) => void): () => void;
  // A partir do app 0.4.1: o processo do jogo terminou.
  onGameEnded?(id: string, onEnded: () => void): () => void;
};

export const desktop = (window as { nimboDesktop?: DesktopBridge }).nimboDesktop;

export async function desktopSignIn() {
  if (!desktop) throw new Error('Disponível só no app.');
  const result = await desktop.signIn();
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

// Toca o PCM recebido do capturador nativo (48 kHz, estéreo, 16 bits) com até ~200 ms de fila:
// começa com 40 ms de folga e descarta o excesso para a latência não crescer.
const WORKLET = `
class NimboPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.frames = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      this.queue.push(e.data);
      this.frames += e.data.length / 2;
      while (this.frames > 9600 && this.queue.length > 1) {
        this.frames -= this.queue.shift().length / 2 - this.offset;
        this.offset = 0;
      }
    };
  }
  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    if (!this.playing && this.frames >= 1920) this.playing = true;
    for (let i = 0; i < left.length; i++) {
      const head = this.queue[0];
      if (!this.playing || !head) {
        left[i] = right[i] = 0;
        continue;
      }
      left[i] = head[this.offset * 2] / 32768;
      right[i] = head[this.offset * 2 + 1] / 32768;
      this.frames--;
      if (++this.offset * 2 >= head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (!this.queue.length) this.playing = false;
    return true;
  }
}
registerProcessor('nimbo-pcm', NimboPcm);
`;

// Faixa de áudio da fonte escolhida no seletor do app (computador sem o próprio Nimbo, ou só o
// aplicativo escolhido). Null quando a pessoa desmarcou o áudio.
export async function desktopAudioTrack(): Promise<MediaStreamTrack | null> {
  if (!desktop) return null;
  const started = await desktop.startAudio();
  if (!started.ok) throw new Error(started.error);
  if (!started.value) return null;
  const { id } = started.value;
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(context, 'nimbo-pcm', { numberOfInputs: 0, outputChannelCount: [2] });
  const destination = context.createMediaStreamDestination();
  node.connect(destination);
  const unsubscribe = desktop.onAudio(
    id,
    (chunk) => {
      const pcm = new Int16Array(chunk.slice().buffer);
      node.port.postMessage(pcm, [pcm.buffer]);
    },
    (error) => {
      if (error) console.warn('[nimbo] áudio do app parou:', error);
    },
  );
  const track = destination.stream.getAudioTracks()[0];
  const stop = track.stop.bind(track);
  track.stop = () => {
    stop();
    unsubscribe();
    void desktop?.stopAudio(id);
    node.disconnect();
    void context.close();
  };
  return track;
}

// Jogo em tela cheia transmitido pelo monitor: avisa quando ele sai da frente (Alt+Tab) para o
// site mostrar a tela de pausa no lugar da área de trabalho.
export type GameWatch = {
  label: string;
  onChange(cb: (active: boolean) => void): void;
  onEnded(cb: () => void): void;
  stop(): void;
};
const gameWatches = new WeakMap<MediaStream, GameWatch>();
export const gameWatchOf = (stream: MediaStream) => gameWatches.get(stream);

export async function watchGameFor(stream: MediaStream) {
  if (!desktop?.startGameWatch || !desktop.onGameState) return;
  const started = await desktop.startGameWatch();
  if (!started.ok || !started.value) return;
  const { id, label } = started.value;
  const listeners: Array<(active: boolean) => void> = [];
  let current: boolean | null = null;
  const unsubscribeState = desktop.onGameState(id, (active) => {
    current = active;
    listeners.forEach((cb) => cb(active));
  });
  const endedListeners: Array<() => void> = [];
  let ended = false;
  const unsubscribeEnded = desktop.onGameEnded?.(id, () => {
    ended = true;
    endedListeners.forEach((cb) => cb());
  });
  const unsubscribe = () => {
    unsubscribeState();
    unsubscribeEnded?.();
  };
  let stopped = false;
  const watch: GameWatch = {
    label,
    // Quem se inscreve depois recebe na hora o último estado conhecido.
    onChange: (cb) => {
      listeners.push(cb);
      if (current !== null) cb(current);
    },
    onEnded: (cb) => {
      endedListeners.push(cb);
      if (ended) cb();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      void desktop?.stopGameWatch?.(id);
    },
  };
  gameWatches.set(stream, watch);
  const video = stream.getVideoTracks()[0];
  if (video) {
    const stop = video.stop.bind(video);
    video.stop = () => {
      stop();
      watch.stop();
    };
    video.addEventListener('ended', watch.stop);
  }
}
