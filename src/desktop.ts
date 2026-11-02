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
