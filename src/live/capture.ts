export type StreamKind = 'screen' | 'camera';
export type CaptureSurface = 'monitor' | 'window';
export type AudioMode = 'window' | 'system' | 'none';
export type CaptureSettings = {
  surface: CaptureSurface;
  quality: 720 | 1080;
  frameRate: 30 | 60;
  audio: AudioMode;
};

export const DEFAULT_CAPTURE: CaptureSettings = {
  surface: 'monitor',
  quality: 1080,
  frameRate: 60,
  audio: 'system',
};

const SETTINGS_KEY = 'nimbo.capture';
export function loadCaptureSettings(): CaptureSettings {
  try {
    return { ...DEFAULT_CAPTURE, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return DEFAULT_CAPTURE;
  }
}
export function saveCaptureSettings(settings: CaptureSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Preferência local apenas; segue sem persistir.
  }
}

// Bitrate máximo por espectador. Cada espectador recebe uma cópia (P2P), então o upload total
// do transmissor é aproximadamente este valor vezes o número de espectadores.
export function maxBitrate(kind: StreamKind, settings: CaptureSettings) {
  if (kind === 'camera') return settings.quality === 1080 ? 2_500_000 : 1_500_000;
  const base = settings.quality === 1080 ? 6_000_000 : 3_500_000;
  return settings.frameRate === 60 ? base : Math.round(base * 0.7);
}

function videoConstraints(settings: CaptureSettings): MediaTrackConstraints {
  return {
    width: { ideal: settings.quality === 1080 ? 1920 : 1280 },
    height: { ideal: settings.quality },
    frameRate: { ideal: settings.frameRate, max: settings.frameRate },
  };
}

type DisplayOptions = DisplayMediaStreamOptions & {
  systemAudio?: 'include' | 'exclude';
  windowAudio?: 'window' | 'system' | 'exclude';
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
  monitorTypeSurfaces?: 'include' | 'exclude';
};

export async function captureScreen(settings: CaptureSettings): Promise<MediaStream> {
  const wantsAudio = settings.audio !== 'none';
  const options: DisplayOptions = {
    video: { ...videoConstraints(settings), displaySurface: settings.surface } as MediaTrackConstraints,
    // restrictOwnAudio impede que o áudio das lives tocando no próprio Nimbo seja recapturado
    // (era a origem do eco). Processamento de voz desligado para não distorcer o som do jogo.
    audio: wantsAudio
      ? ({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          restrictOwnAudio: true,
          suppressLocalAudioPlayback: false,
        } as MediaTrackConstraints)
      : false,
    systemAudio: settings.audio === 'system' ? 'include' : 'exclude',
    windowAudio: settings.audio === 'none' ? 'exclude' : settings.audio,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  const video = stream.getVideoTracks()[0];
  if (video) video.contentHint = 'motion';
  return stream;
}

export async function captureCamera(settings: CaptureSettings): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ video: videoConstraints(settings), audio: false });
}

export function supportsOwnAudioRestriction() {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() as
    | Record<string, boolean>
    | undefined;
  return Boolean(supported?.restrictOwnAudio);
}

// Fonte sintética para testes locais com emuladores (?fakeMedia=1), sem precisar de tela ou câmera.
export function createTestStream(label: string, frameRate = 30): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;
  const hue = [...label].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 360;
  let frame = 0;
  const timer = setInterval(() => {
    frame++;
    ctx.fillStyle = `hsl(${hue} 55% 22%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = `hsl(${hue} 80% 65%)`;
    ctx.beginPath();
    ctx.arc(640 + Math.sin(frame / 15) * 420, 360, 70, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 64px system-ui';
    ctx.fillText(label, 60, 110);
    ctx.font = '32px system-ui';
    ctx.fillText(new Date().toLocaleTimeString(), 60, 660);
  }, 1000 / frameRate);
  const stream = canvas.captureStream(frameRate);
  const audio = new AudioContext();
  const osc = audio.createOscillator();
  osc.frequency.value = 220 + (hue % 200);
  const gain = audio.createGain();
  gain.gain.value = 0.05;
  const dest = audio.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  stream.addTrack(dest.stream.getAudioTracks()[0]);
  // stop() não dispara 'ended', então a limpeza fica no próprio stop da faixa de vídeo.
  const video = stream.getVideoTracks()[0];
  const stopVideo = video.stop.bind(video);
  video.stop = () => {
    clearInterval(timer);
    osc.stop();
    void audio.close();
    stopVideo();
  };
  return stream;
}
