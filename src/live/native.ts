// Live de tela enviada pelo motor em Rust do app, e não pelo navegador.
//
// Quem transmite: o app captura e codifica uma vez só (pela placa de vídeo) e manda a mesma imagem
// para todos. A página só repassa a sinalização: recebe a oferta de quem quer assistir, entrega ao
// motor e devolve a resposta.
//
// Quem assiste (site, celular ou app): vê `native: true` no anúncio da live e abre uma conexão
// própria, só de recepção, direto com o motor do transmissor.
import { desktop } from '../desktop';
import type { Broadcasts } from './room';
import type { StreamKind } from './capture';

export type NativeQuality = { fps: number; bitrate: number; maxHeight: number };
export type NativeSignal = { type: 'offer' | 'answer'; sdp: RTCSessionDescriptionInit; native: StreamKind };

// Só existe no app em Rust; no navegador e no app antigo fica indefinido.
export const nativeMedia = desktop?.media;

// Prévia local de cada live nativa: é uma conexão de espectador com o próprio motor.
const previews = new WeakMap<MediaStream, { pc: RTCPeerConnection; id: number }>();
export const isNativeLive = (stream: MediaStream) => previews.has(stream);

// Espera os endereços de rede serem levantados, com teto: a oferta vai inteira numa mensagem só.
function gathered(pc: RTCPeerConnection, maxMs: number) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, maxMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

// Começa a captura no motor e devolve a prévia. O MediaStream devolvido representa a live: é o que
// o resto do app recebe no lugar do stream do getDisplayMedia.
export async function captureScreenNative(quality: NativeQuality): Promise<MediaStream> {
  const media = nativeMedia;
  if (!media) throw new Error('Disponível só no app.');
  const started = await media.start(null, quality);
  if (!started.ok) throw new Error(started.error);
  const pc = new RTCPeerConnection();
  try {
    pc.addTransceiver('video', { direction: 'recvonly' });
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const track = new Promise<MediaStreamTrack>((resolve, reject) => {
      pc.ontrack = (e) => resolve(e.track);
      giveUp = setTimeout(() => reject(new Error('O vídeo do app não respondeu. Tente de novo.')), 10000);
    }).finally(() => clearTimeout(giveUp));
    // Se um passo anterior falhar, esta espera é abandonada: não pode virar erro solto no console.
    track.catch(() => {});
    await pc.setLocalDescription();
    await gathered(pc, 1500);
    const answer = await media.accept(JSON.stringify(pc.localDescription));
    if (!answer.ok) throw new Error(answer.error);
    await pc.setRemoteDescription(JSON.parse(answer.value.answer) as RTCSessionDescriptionInit);
    const stream = new MediaStream([await track]);
    previews.set(stream, { pc, id: answer.value.id });
    return stream;
  } catch (e) {
    pc.close();
    void media.stop();
    throw e;
  }
}

// Fecha só a prévia. A captura continua (troca de fonte) até alguém chamar stopNative.
export function releaseNativePreview(stream: MediaStream) {
  const preview = previews.get(stream);
  if (!preview) return;
  previews.delete(stream);
  preview.pc.close();
  void nativeMedia?.close(preview.id);
}

export function stopNative(stream: MediaStream) {
  releaseNativePreview(stream);
  void nativeMedia?.stop();
}

// Entrega ao motor a oferta de um espectador e devolve a resposta para mandar de volta.
export async function answerNative(offer: RTCSessionDescriptionInit) {
  const media = nativeMedia;
  if (!media) throw new Error('Disponível só no app.');
  const result = await media.accept(JSON.stringify(offer));
  if (!result.ok) throw new Error(result.error);
  return { id: result.value.id, answer: JSON.parse(result.value.answer) as RTCSessionDescriptionInit };
}

type Incoming = {
  pc: RTCPeerConnection;
  uid: string;
  kind: StreamKind;
  streamId: string;
  stream: MediaStream;
  tries: number;
  timer: ReturnType<typeof setTimeout>;
};

type Deps = {
  ice: () => RTCConfiguration;
  send: (to: string, msg: NativeSignal) => Promise<void>;
  // Chamado quando o vídeo de uma live nativa chega ou vai embora.
  onChange: () => void;
};

const TRIES = 3;
const CONNECT_MS = 12000;

// Lado de quem assiste: uma conexão só de recepção para cada live nativa do canal.
export class NativeReceiver {
  private conns = new Map<string, Incoming>();
  // Lives que já esgotaram as tentativas; só tenta de novo quando a live recomeça.
  private gaveUp = new Set<string>();

  constructor(private deps: Deps) {}

  // Abre conexão para as lives nativas anunciadas e fecha as que acabaram.
  sync(broadcasts: Broadcasts, members: string[], self: string) {
    const wanted = new Map<string, { uid: string; kind: StreamKind; streamId: string }>();
    for (const [uid, kinds] of Object.entries(broadcasts)) {
      if (uid === self || !members.includes(uid)) continue;
      for (const [kind, live] of Object.entries(kinds))
        if (live?.native) wanted.set(`${uid}:${kind}`, { uid, kind: kind as StreamKind, streamId: live.streamId });
    }
    for (const [key, conn] of this.conns)
      if (wanted.get(key)?.streamId !== conn.streamId) this.close(key);
    for (const key of [...this.gaveUp]) {
      const [base, streamId] = key.split('|');
      if (wanted.get(base)?.streamId !== streamId) this.gaveUp.delete(key);
    }
    for (const [key, live] of wanted)
      if (!this.conns.has(key) && !this.gaveUp.has(`${key}|${live.streamId}`)) this.open(key, live, 0);
  }

  private open(key: string, live: { uid: string; kind: StreamKind; streamId: string }, tries: number) {
    const pc = new RTCPeerConnection(this.deps.ice());
    const stream = new MediaStream();
    const retry = () => {
      if (this.conns.get(key)?.pc !== pc) return;
      this.close(key);
      if (tries + 1 < TRIES) this.open(key, live, tries + 1);
      else {
        this.gaveUp.add(`${key}|${live.streamId}`);
        console.warn('[nimbo] live do app não conectou', live.uid.slice(0, 5));
      }
    };
    const conn: Incoming = { pc, ...live, stream, tries, timer: setTimeout(retry, CONNECT_MS) };
    this.conns.set(key, conn);
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = ({ track }) => {
      stream.addTrack(track);
      track.onunmute = () => this.deps.onChange();
      this.deps.onChange();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') clearTimeout(conn.timer);
      else if (pc.connectionState === 'failed') retry();
    };
    void (async () => {
      await pc.setLocalDescription();
      await gathered(pc, 2000);
      if (this.conns.get(key)?.pc !== pc || !pc.localDescription) return;
      await this.deps.send(live.uid, { type: 'offer', sdp: pc.localDescription.toJSON(), native: live.kind });
    })().catch((e) => {
      console.warn('[nimbo] oferta para o app', e);
      retry();
    });
  }

  // Resposta do motor do transmissor à nossa oferta.
  async onAnswer(uid: string, kind: StreamKind, sdp: RTCSessionDescriptionInit) {
    const conn = this.conns.get(`${uid}:${kind}`);
    if (!conn || conn.pc.signalingState !== 'have-local-offer') return;
    await conn.pc.setRemoteDescription(sdp);
  }

  // Vídeos recebidos, por participante e pelo id anunciado da live (como os do navegador).
  streams() {
    const out: Record<string, Record<string, MediaStream>> = {};
    for (const conn of this.conns.values())
      if (conn.stream.getTracks().length) (out[conn.uid] ??= {})[conn.streamId] = conn.stream;
    return out;
  }

  has(uid: string) {
    for (const conn of this.conns.values()) if (conn.uid === uid && conn.stream.getTracks().length) return true;
    return false;
  }

  // Para a conta de uso do servidor de retransmissão.
  connections() {
    return [...this.conns.values()].map((c) => c.pc);
  }

  private close(key: string) {
    const conn = this.conns.get(key);
    if (!conn) return;
    clearTimeout(conn.timer);
    this.conns.delete(key);
    conn.pc.onconnectionstatechange = null;
    conn.pc.close();
    this.deps.onChange();
  }

  closeAll() {
    for (const key of [...this.conns.keys()]) this.close(key);
    this.gaveUp.clear();
  }
}
