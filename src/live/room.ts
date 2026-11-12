import {
  get,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
  type Database,
} from 'firebase/database';
import { LEVELS, nextQuality, type QualityState } from './quality';
import { hardwareH264, MAX_HARDWARE_SENDERS, preferH264 } from './hwcodec';
import { addTurnUsage, loadTurn, loadTurnUsage, type TurnConfig } from '../community';
import {
  answerNative,
  isNativeLive,
  nativeMedia,
  NativeReceiver,
  releaseNativePreview,
  stopNative,
  type NativeSignal,
} from './native';
import type { StreamKind } from './capture';

// Sinalização: rooms/{room}/signals/{destinatário}/{remetente}/{id}
type Signal =
  | { type: 'offer' | 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }
  // Live enviada pelo motor em Rust do app: oferta de quem assiste e resposta do motor (native.ts).
  | NativeSignal;

// Cada pessoa pode ter até duas lives: tela e câmera. streamId é o id do MediaStream anunciado na
// negociação; é como quem assiste sabe qual stream recebido é a tela e qual é a câmera.
// native: a live é enviada pelo motor do app; quem assiste abre uma conexão própria (native.ts).
export type Broadcast = { startedAt: number; streamId: string; native?: boolean };
export type Broadcasts = Record<string, Partial<Record<StreamKind, Broadcast>>>;
export const STREAM_KINDS: StreamKind[] = ['screen', 'camera'];

// Identificador de cada live na interface: "uid:screen" ou "uid:camera".
export const liveKey = (uid: string, kind: StreamKind) => `${uid}:${kind}`;
export const parseLiveKey = (key: string) => {
  const i = key.lastIndexOf(':');
  return { uid: key.slice(0, i), kind: key.slice(i + 1) as StreamKind };
};

export function parseBroadcasts(raw: unknown): Broadcasts {
  const result: Broadcasts = {};
  for (const [uid, value] of Object.entries((raw as Record<string, unknown>) || {})) {
    if (!value || typeof value !== 'object') continue;
    for (const kind of STREAM_KINDS) {
      const live = (value as Record<string, Broadcast | undefined>)[kind];
      if (live && typeof live === 'object' && live.streamId) (result[uid] ??= {})[kind] = live;
    }
  }
  return result;
}

export type LiveSnapshot = {
  room: string;
  joined: boolean;
  online: boolean;
  members: string[];
  broadcasts: Broadcasts;
  // Prévia local de cada live própria.
  local: Partial<Record<StreamKind, MediaStream>>;
  // Streams recebidos por participante, indexados pelo id anunciado.
  remote: Record<string, Record<string, MediaStream>>;
  // Participantes cuja conexão P2P falhou de vez (sem TURN, algumas redes bloqueiam).
  failed: string[];
  // Participantes cuja conexão P2P ainda está sendo negociada (sem caminho de rede ainda).
  connecting: string[];
};

export type PeerDiagnostics = {
  peer: string;
  connection: RTCPeerConnectionState;
  ice: RTCIceConnectionState;
  signaling: RTCSignalingState;
  route: string;
  videoBytesIn: number;
  videoBytesOut: number;
  framesIn: number;
  localCandidates: string;
  remoteCandidates: string;
  pairs: string;
  iceRestarts: number;
  encoder: string;
};

type Peer = {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  candidates: RTCIceCandidateInit[];
  transceivers: Partial<Record<StreamKind, RTCRtpTransceiver[]>>;
  queue: Promise<void>;
  // Desde quando o ICE procura caminho sem achar, e quantas rotas novas já foram pedidas.
  checkingSince: number;
  iceRestarts: number;
  lastIceRestart: number;
  // Envios de vídeo que preferem o codificador da placa de vídeo.
  hardware: Set<RTCRtpTransceiver>;
};

type LocalLive = {
  // Stream atual (muda ao trocar de tela) e o anunciado na negociação (fixo por tipo enquanto você
  // estiver no canal, para a mesma conexão servir de novo quando a live recomeçar).
  stream: MediaStream;
  announced: MediaStream;
  bitrate: number;
  startedAt: number;
  // Jogo fora da frente: quem assiste recebe a tela de pausa no lugar do vídeo.
  paused?: boolean;
};

// Tela "Pausado · volta já" desenhada num canvas. Fica viva enquanto a sala existir; precisa ser
// redesenhada de tempos em tempos para o canvas continuar gerando quadros.
function createPauseTrack(): { track: MediaStreamTrack; stop(): void } {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;
  const icon = new Image();
  icon.src = '/nimbo-icon-256.png';
  const draw = () => {
    const bg = ctx.createRadialGradient(640, 250, 40, 640, 360, 760);
    bg.addColorStop(0, '#2a2266');
    bg.addColorStop(1, '#0b1020');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1280, 720);
    if (icon.complete && icon.naturalWidth) ctx.drawImage(icon, 576, 170, 128, 128);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#eef1ff';
    ctx.font = '700 54px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.fillText('Pausado', 640, 380);
    ctx.fillStyle = '#9aa6c4';
    ctx.font = '400 28px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.fillText('Saiu do jogo por um instante · volta já', 640, 430);
  };
  draw();
  const timer = setInterval(draw, 500);
  const track = canvas.captureStream(4).getVideoTracks()[0];
  track.contentHint = 'detail';
  return {
    track,
    stop: () => {
      clearInterval(timer);
      track.stop();
    },
  };
}

// TURN é opcional (VITE_TURN_URLS separado por vírgula, VITE_TURN_USERNAME, VITE_TURN_CREDENTIAL).
// Sem ele, redes com NAT restritivo não conseguem conexão direta.
// Só entra se estiver completo: TURN sem usuário ou senha faz o navegador recusar a conexão inteira.
const turnUrls =
  import.meta.env.VITE_TURN_USERNAME && import.meta.env.VITE_TURN_CREDENTIAL
    ? (import.meta.env.VITE_TURN_URLS || '')
        .split(',')
        .map((u: string) => u.trim())
        .filter(Boolean)
    : [];
const ICE: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    ...(turnUrls.length
      ? [
          {
            urls: turnUrls,
            username: import.meta.env.VITE_TURN_USERNAME,
            credential: import.meta.env.VITE_TURN_CREDENTIAL,
          },
        ]
      : []),
  ],
};

export const MAX_MEMBERS = 20;

// Servidores ICE com o TURN salvo pelo proprietário (aba "Rede"), quando houver.
function iceWith(turn: TurnConfig | null): RTCConfiguration {
  if (!turn?.urls || !turn.username || !turn.credential) return ICE;
  return {
    iceServers: [
      ...(ICE.iceServers || []),
      { urls: turn.urls.split(',').filter(Boolean), username: turn.username, credential: turn.credential },
    ],
  };
}

// Confere se um TURN responde: força uma conexão só por relay e espera um candidato dele. Sem
// servidores informados, testa o configurado no build (VITE_TURN_*).
export async function testTurn(servers?: RTCIceServer[], timeoutMs = 8000) {
  if (!servers && !turnUrls.length) return { configured: false, works: false };
  const pc = new RTCPeerConnection({ ...(servers ? { iceServers: servers } : ICE), iceTransportPolicy: 'relay' });
  pc.createDataChannel('turn-test');
  const works = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate?.type === 'relay') {
        clearTimeout(timer);
        resolve(true);
      }
    };
    void pc.createOffer().then((offer) => pc.setLocalDescription(offer));
  });
  pc.close();
  return { configured: true, works };
}

const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export class LiveRoom {
  private peers = new Map<string, Peer>();
  private remote: Record<string, Record<string, MediaStream>> = {};
  private failed = new Set<string>();
  private members: string[] = [];
  // joinedAt identifica a sessão de cada participante: muda quando a pessoa recarrega ou reconecta.
  private sessions: Record<string, unknown> = {};
  private membersLoaded = false;
  private pendingInbox: Record<string, Record<string, Signal>> | null = null;
  private broadcasts: Broadcasts = {};
  private locals = new Map<StreamKind, LocalLive>();
  private announced = new Map<StreamKind, MediaStream>();
  private pause: { track: MediaStreamTrack; stop(): void } | null = null;
  private quality = new WeakMap<RTCRtpSender, QualityState>();
  private ice: RTCConfiguration = ICE;
  private unsubs: Array<() => void> = [];
  private seen = new Set<string>();
  private joined = false;
  private online = true;
  private closed = false;
  // Desde quando cada live anunciada está sem chegar, e quando foi a última reconexão completa.
  private missingSince: Record<string, number> = {};
  private lastResync = 0;
  private autoResyncs = 0;
  // Quando esta sessão entrou no canal (ou reconectou): nos primeiros 30 s a live presa é
  // percebida mais cedo, porque é aí que a conexão com quem transmite está sendo refeita.
  private sessionStart = 0;
  // Lives nativas que chegam (lado de quem assiste) e conexões abertas no motor para quem nos
  // assiste (lado de quem transmite), por "participante:tipo".
  private nativeIn = new NativeReceiver({
    ice: () => this.ice,
    send: (to, msg) => this.send(to, msg),
    onChange: () => this.emit(),
  });
  private nativeOut = new Map<string, number>();

  constructor(
    private db: Database,
    private uid: string,
    readonly room: string,
    private onChange: (snapshot: LiveSnapshot) => void,
    // fatal = o acesso ao canal foi perdido (permissão revogada ou canal removido).
    private onIssue: (message: string, fatal?: boolean) => void,
  ) {}

  private path(suffix: string) {
    return ref(this.db, `rooms/${this.room}/${suffix}`);
  }
  private get memberRef() {
    return this.path(`members/${this.uid}`);
  }
  private get streamsRef() {
    return this.path(`streams/${this.uid}`);
  }

  snapshot(): LiveSnapshot {
    return {
      room: this.room,
      joined: this.joined,
      online: this.online,
      members: this.members,
      broadcasts: this.broadcasts,
      local: Object.fromEntries([...this.locals].map(([kind, live]) => [kind, live.stream])),
      remote: this.allRemote(),
      failed: [...this.failed],
      connecting: [...this.peers.entries()]
        .filter(([, p]) => p.pc.connectionState !== 'connected' && p.pc.connectionState !== 'failed')
        .map(([id]) => id),
    };
  }
  // Streams recebidos pelo navegador e pelas conexões com motores nativos, juntos.
  private allRemote() {
    const all: Record<string, Record<string, MediaStream>> = {};
    for (const [id, streams] of Object.entries(this.remote)) all[id] = { ...streams };
    for (const [id, streams] of Object.entries(this.nativeIn.streams())) all[id] = { ...all[id], ...streams };
    return all;
  }
  private emit() {
    if (!this.closed) this.onChange(this.snapshot());
  }

  async join() {
    const members = (await get(this.path('members'))).val() as Record<string, unknown> | null;
    if (Object.keys(members || {}).length >= MAX_MEMBERS && !members?.[this.uid]) throw Error('Canal cheio');
    // Trava de gasto: com o uso do mês no limite definido, o servidor de retransmissão fica de fora.
    const [turn, usage] = await Promise.all([loadTurn(), loadTurnUsage()]);
    const limit = (turn?.monthlyLimitGb || 0) * 1e9;
    const capped = Boolean(limit) && usage >= limit;
    if (capped) console.info('[nimbo] servidor de retransmissão no limite do mês; usando só conexão direta');
    this.ice = iceWith(capped ? null : turn);
    await this.clearInbox();
    await this.registerPresence();
    this.joined = true;
    this.listen();
    this.emit();
  }

  // Mensagens antigas de outra sessão quebrariam a negociação nova.
  private async clearInbox() {
    const inbox = (await get(this.path(`signals/${this.uid}`))).val() as Record<
      string,
      Record<string, unknown>
    > | null;
    const removals: Record<string, null> = {};
    for (const [sender, msgs] of Object.entries(inbox || {}))
      for (const id of Object.keys(msgs || {})) removals[`signals/${this.uid}/${sender}/${id}`] = null;
    if (Object.keys(removals).length) await update(ref(this.db, `rooms/${this.room}`), removals);
  }

  // O onDisconnect é registrado antes da escrita para que uma queda logo após entrar não deixe sessão órfã.
  private async registerPresence(reset = false) {
    // Depois de uma queda os outros recriam as conexões com a gente; as antigas daqui não servem mais.
    if (reset) for (const id of [...this.peers.keys()]) this.closePeer(id);
    await onDisconnect(this.memberRef).remove();
    await set(this.memberRef, { joinedAt: serverTimestamp() });
    this.sessionStart = Date.now();
    for (const kind of this.locals.keys()) await this.publishStream(kind);
  }

  private async publishStream(kind: StreamKind) {
    const live = this.locals.get(kind);
    if (!live) return;
    await onDisconnect(this.streamsRef).remove();
    await set(this.path(`streams/${this.uid}/${kind}`), {
      startedAt: live.startedAt,
      streamId: live.announced.id,
      ...(isNativeLive(live.stream) ? { native: true } : {}),
    });
  }

  private listen() {
    let wasOffline = false;
    const watchdog = setInterval(() => this.checkMissing(), 2000);
    const adapt = setInterval(() => void this.adaptQuality(), 3000);
    const relay = setInterval(() => void this.reportRelayUsage(), 60000);
    this.unsubs.push(() => clearInterval(watchdog), () => clearInterval(adapt), () => clearInterval(relay));
    this.unsubs.push(
      onValue(ref(this.db, '.info/connected'), (snap) => {
        const connected = snap.val() === true;
        this.online = connected;
        if (!connected) wasOffline = true;
        else if (wasOffline && this.joined) {
          // O servidor já executou o onDisconnect durante a queda: registra a presença de novo.
          wasOffline = false;
          void this.registerPresence(true).catch((e) => this.onIssue(String(e)));
        }
        this.emit();
      }),
    );
    this.unsubs.push(
      onValue(
        this.path('members'),
        (snap) => this.onMembers(snap.val() || {}),
        () => this.onIssue('Você perdeu o acesso a este canal', true),
      ),
    );
    this.unsubs.push(
      onValue(
        this.path('streams'),
        (snap) => this.onBroadcasts(snap.val() || {}),
        () => {},
      ),
    );
    this.unsubs.push(
      onValue(
        this.path(`signals/${this.uid}`),
        (snap) => this.onInbox(snap.val() as Record<string, Record<string, Signal>> | null),
        () => {},
      ),
    );
  }

  private onMembers(entries: Record<string, { joinedAt?: unknown }>) {
    const ids = Object.keys(entries);
    for (const id of ids) {
      const session = entries[id]?.joinedAt;
      // Mesma conta numa sessão nova (recarregou a página): a conexão antiga não serve mais, porque a
      // criptografia do vídeo é negociada por sessão e ficaria preta mesmo com a sinalização em dia.
      if (id !== this.uid && id in this.sessions && this.sessions[id] !== session) this.closePeer(id);
      this.sessions[id] = session;
    }
    for (const id of Object.keys(this.sessions)) if (!(id in entries)) delete this.sessions[id];
    this.members = ids;
    const firstLoad = !this.membersLoaded;
    this.membersLoaded = true;
    const present = new Set(ids);
    for (const id of [...this.peers.keys()]) if (!present.has(id)) this.closePeer(id);
    for (const id of [...this.failed]) if (!present.has(id)) this.failed.delete(id);
    this.closeNativeOut((uid) => !present.has(uid));
    this.nativeIn.sync(this.broadcasts, ids, this.uid);
    // Quem transmite inicia a conexão com quem chega; quem só assiste espera a oferta.
    if ([...this.locals.values()].some((live) => !isNativeLive(live.stream)))
      for (const id of ids) if (id !== this.uid) this.ensurePeer(id);
    // Sinais que chegaram antes da lista de membros ficam guardados até aqui.
    if (firstLoad && this.pendingInbox) this.onInbox(this.pendingInbox);
    this.emit();
  }

  private onBroadcasts(raw: unknown) {
    const next = parseBroadcasts(raw);
    // As faixas remotas não são descartadas aqui: elas podem chegar antes do registro da live.
    // A interface só exibe quem está em broadcasts, e o removetrack/closePeer limpa o resto.
    this.broadcasts = next;
    this.nativeIn.sync(next, this.members, this.uid);
    this.emit();
  }

  private onInbox(data: Record<string, Record<string, Signal>> | null) {
    if (!this.membersLoaded) {
      this.pendingInbox = data;
      return;
    }
    this.pendingInbox = null;
    for (const [sender, msgs] of Object.entries(data || {}))
      for (const [id, msg] of Object.entries(msgs || {})) {
        const key = sender + '/' + id;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        const target = this.path(`signals/${this.uid}/${sender}/${id}`);
        const discard = () =>
          remove(target).then(
            () => this.seen.delete(key),
            () => {},
          );
        // Sobras de quem já saiu do canal não devem recriar uma conexão.
        if (!this.members.includes(sender)) {
          void discard();
          continue;
        }
        if ('native' in msg) {
          void this.handleNative(sender, msg)
            .catch((e) => console.warn('[nimbo] sinal do app', sender, e))
            .finally(() => void discard());
          continue;
        }
        const peer = this.ensurePeer(sender);
        // Uma fila por participante: oferta, resposta e candidatos são aplicados na ordem de chegada.
        peer.queue = peer.queue
          .then(() => this.handle(sender, peer, msg))
          .catch((e) => console.warn('[nimbo] sinal', sender, e))
          .finally(() => void discard());
      }
  }

  // Oferta de quem quer assistir a nossa live nativa, ou resposta do motor de quem assistimos.
  private async handleNative(sender: string, msg: NativeSignal) {
    if (msg.type === 'answer') return this.nativeIn.onAnswer(sender, msg.native, msg.sdp);
    const live = this.locals.get(msg.native);
    if (!live || !isNativeLive(live.stream)) return;
    const key = sender + ':' + msg.native;
    const previous = this.nativeOut.get(key);
    if (previous !== undefined) void nativeMedia?.close(previous);
    const { id, answer } = await answerNative(msg.sdp);
    this.nativeOut.set(key, id);
    await this.send(sender, { type: 'answer', sdp: answer, native: msg.native });
  }

  // Fecha no motor as conexões de quem nos assistia (um participante, um tipo de live, ou todos).
  private closeNativeOut(match: (uid: string, kind: string) => boolean) {
    for (const [key, id] of [...this.nativeOut]) {
      const i = key.lastIndexOf(':');
      if (!match(key.slice(0, i), key.slice(i + 1))) continue;
      this.nativeOut.delete(key);
      void nativeMedia?.close(id);
    }
  }

  private send(to: string, msg: Signal) {
    return push(this.path(`signals/${to}/${this.uid}`), clean(msg)).then(() => undefined);
  }

  private ensurePeer(id: string): Peer {
    const existing = this.peers.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection(this.ice);
    // "Perfect negotiation": em colisão de ofertas, o lado educado cede e o outro mantém a sua.
    const peer: Peer = {
      pc,
      polite: this.uid > id,
      makingOffer: false,
      ignoreOffer: false,
      candidates: [],
      transceivers: {},
      queue: Promise.resolve(),
      checkingSince: 0,
      iceRestarts: 0,
      lastIceRestart: 0,
      hardware: new Set(),
    };
    this.peers.set(id, peer);
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        const desc = pc.localDescription!;
        await this.send(id, { type: desc.type as 'offer', sdp: desc.toJSON() });
      } catch (e) {
        console.warn('[nimbo] oferta', id, e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate?.candidate)
        void this.send(id, { type: 'ice', candidate: candidate.toJSON() }).catch(() => {});
    };
    pc.oniceconnectionstatechange = () => {
      console.info('[nimbo] ICE', id.slice(0, 5), pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') peer.iceRestarts = 0;
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };
    pc.onconnectionstatechange = () => {
      console.info('[nimbo] conexão', id.slice(0, 5), pc.connectionState);
      if (pc.connectionState === 'connected') this.failed.delete(id);
      else if (pc.connectionState === 'failed') this.failed.add(id);
      this.emit();
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      const byId = (this.remote[id] ??= {});
      byId[stream.id] = stream;
      stream.onremovetrack = () => {
        if (!stream.getTracks().length && this.remote[id]?.[stream.id] === stream)
          delete this.remote[id][stream.id];
        this.emit();
      };
      track.onunmute = () => this.emit();
      this.emit();
    };
    for (const kind of this.locals.keys()) this.syncSenders(peer, kind);
    return peer;
  }

  // Põe nos envios desta conexão as faixas atuais da live (ou nada, se ela parou). Os canais de envio
  // nunca são desmontados: parar, recomeçar ou trocar de tela só troca a faixa, sem renegociar.
  // Desmontar (transceiver.stop) podia mudar o transporte da conexão inteira e congelar também as
  // lives que chegam pela mesma conexão.
  private syncSenders(peer: Peer, kind: StreamKind) {
    // Live nativa não passa pelo navegador: aqui ela conta como "sem faixas para enviar".
    const local = this.locals.get(kind);
    const live = local && !isNativeLive(local.stream) ? local : undefined;
    const transceivers = peer.transceivers[kind] || [];
    for (const trackKind of ['video', 'audio'] as const) {
      let track = live?.stream.getTracks().find((t) => t.kind === trackKind) || null;
      if (track && live?.paused && trackKind === 'video') track = (this.pause ??= createPauseTrack()).track;
      const existing = transceivers.find(
        (t) => t.receiver.track.kind === trackKind && t.currentDirection !== 'stopped',
      );
      if (existing) {
        if (existing.sender.track !== track) void existing.sender.replaceTrack(track).catch(() => {});
        if (track && live && trackKind === 'video') void this.applyQuality(existing.sender, live.bitrate);
      } else if (track && live) {
        const added = peer.pc.addTransceiver(track, {
          direction: 'sendonly',
          streams: [live.announced],
          sendEncodings: trackKind === 'video' ? [{ maxBitrate: live.bitrate }] : undefined,
        });
        if (trackKind === 'video' && this.hardware && this.hardwareSenders() < MAX_HARDWARE_SENDERS && preferH264(added))
          peer.hardware.add(added);
        transceivers.push(added);
      }
    }
    if (transceivers.length) peer.transceivers[kind] = transceivers;
  }

  // Envios de vídeo que hoje preferem o codificador da placa de vídeo, somando todas as conexões.
  private hardwareSenders() {
    let n = 0;
    for (const peer of this.peers.values()) n += peer.hardware.size;
    return n;
  }

  // Aplica no envio o nível de qualidade atual desta conexão sobre o bitrate escolhido.
  private async applyQuality(sender: RTCRtpSender, bitrate: number) {
    const level = LEVELS[this.quality.get(sender)?.level ?? 0];
    const params = sender.getParameters();
    const encoding = params.encodings?.[0];
    if (!encoding) return;
    const maxBitrate = Math.round(bitrate * level.bitrate);
    if (
      encoding.maxBitrate === maxBitrate &&
      (encoding.scaleResolutionDownBy ?? 1) === level.scale &&
      encoding.maxFramerate === level.maxFps
    )
      return;
    encoding.maxBitrate = maxBitrate;
    encoding.scaleResolutionDownBy = level.scale;
    if (level.maxFps) encoding.maxFramerate = level.maxFps;
    else delete encoding.maxFramerate;
    await sender.setParameters(params).catch(() => {});
  }

  // Bytes já contados por conexão que passa pelo servidor de retransmissão.
  private relayCounted = new WeakMap<RTCPeerConnection, number>();
  // A máquina codifica H.264 pela placa de vídeo (descoberto ao abrir a primeira live).
  private hardware = false;

  // A cada minuto, soma ao contador do mês o que chegou por TURN (é o que o serviço cobra: dados
  // saindo do servidor para cada app). Conexões diretas não contam.
  private async reportRelayUsage() {
    if (!this.joined || this.closed) return;
    let total = 0;
    const connections = [...this.peers.values()].map((p) => p.pc).concat(this.nativeIn.connections());
    for (const pc of connections) {
      const peer = { pc };
      const stats = await peer.pc.getStats().catch(() => null);
      if (!stats) continue;
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((r) => byId.set(r.id, r as Record<string, unknown>));
      let received = 0;
      stats.forEach((r: Record<string, unknown>) => {
        if (r.type !== 'candidate-pair' || r.state !== 'succeeded') return;
        const local = byId.get(r.localCandidateId as string);
        if (local?.candidateType === 'relay') received += Number(r.bytesReceived || 0);
      });
      if (!received) continue;
      const before = this.relayCounted.get(peer.pc) || 0;
      if (received > before) total += received - before;
      this.relayCounted.set(peer.pc, received);
    }
    if (total > 0) await addTurnUsage(total).catch(() => {});
  }

  // A cada 3 s, mede cada envio de vídeo (perda relatada por quem assiste e se falta banda) e
  // ajusta o nível só daquela conexão. Os primeiros 15 s de cada live ficam de fora: a estimativa
  // de banda ainda está subindo.
  private async adaptQuality() {
    if (!this.joined || this.closed) return;
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState !== 'connected') continue;
      const senders: Array<{ sender: RTCRtpSender; live: LocalLive }> = [];
      for (const [kind, transceivers] of Object.entries(peer.transceivers)) {
        const live = this.locals.get(kind as StreamKind);
        const video = transceivers?.find((t) => t.sender.track?.kind === 'video');
        if (live && video && !live.paused && Date.now() - live.startedAt > 15000) senders.push({ sender: video.sender, live });
      }
      for (const { sender, live } of senders) {
        const stats = await sender.getStats().catch(() => null);
        if (!stats) continue;
        let loss = 0;
        let limited = false;
        let available = 0;
        stats.forEach((r) => {
          if (r.type === 'remote-inbound-rtp' && typeof r.fractionLost === 'number') loss = r.fractionLost;
          if (r.type === 'outbound-rtp') limited = r.qualityLimitationReason === 'bandwidth';
          if (r.type === 'candidate-pair' && r.nominated && r.availableOutgoingBitrate)
            available = r.availableOutgoingBitrate / senders.length;
        });
        const state = this.quality.get(sender) ?? { level: 0, bad: 0, good: 0 };
        const current = live.bitrate * LEVELS[state.level].bitrate;
        const next = nextQuality(state, { loss, limited, available, current });
        this.quality.set(sender, next);
        if (next.level !== state.level) {
          console.info('[nimbo] qualidade', next.level, 'perda', loss.toFixed(3), 'banda', Math.round(available / 1000), 'kbps');
          await this.applyQuality(sender, live.bitrate);
        }
      }
    }
  }

  private async handle(id: string, peer: Peer, msg: Signal) {
    const { pc } = peer;
    if (pc.signalingState === 'closed') return;
    if (msg.type === 'ice') {
      if (!pc.remoteDescription) {
        peer.candidates.push(msg.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (e) {
        if (!peer.ignoreOffer) throw e;
      }
      return;
    }
    const collision = msg.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    await pc.setRemoteDescription(msg.sdp); // rollback implícito quando há colisão
    for (const c of peer.candidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    if (msg.type === 'offer') {
      await pc.setLocalDescription();
      const desc = pc.localDescription!;
      await this.send(id, { type: 'answer', sdp: desc.toJSON() });
    }
  }

  private closePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.onnegotiationneeded = null;
    peer.pc.close();
    this.peers.delete(id);
    delete this.remote[id];
    if (!this.members.includes(id)) this.closeNativeOut((uid) => uid === id);
  }

  // Botão "Tentar de novo": se o vídeo já chegou e só a rota caiu, pede uma rota nova; se nunca
  // chegou, reconecta do zero.
  retry(id: string) {
    const peer = this.peers.get(id);
    this.failed.delete(id);
    if (peer && Object.keys(this.remote[id] || {}).length) {
      peer.pc.restartIce();
      this.emit();
      return;
    }
    void this.resync();
  }

  // Reconexão completa, igual a recarregar a página: uma sessão nova faz cada pessoa que está
  // transmitindo descartar a conexão antiga com a gente e mandar uma oferta nova. Resolve o caso
  // em que uma das pontas caiu e voltou e a conexão ficou perdida sem ninguém refazer.
  private async resync() {
    if (!this.joined || this.closed || !this.online) return;
    this.lastResync = Date.now();
    this.missingSince = {};
    console.info('[nimbo] reconectando o canal');
    await this.registerPresence(true).catch((e) => this.onIssue(String(e)));
    this.emit();
  }

  // Live anunciada que não chega em 20 s dispara uma reconexão (no máximo uma a cada 45 s e três
  // seguidas). Conexões que falharam de vez (rede bloqueando P2P) ficam com o botão manual.
  private checkMissing() {
    if (!this.joined || !this.online) return;
    const now = Date.now();
    // Caminho de rede que não aparece em 8 s: pede uma rota nova (até 3 vezes, a cada 12 s), em
    // vez de esperar o navegador desistir de vez, o que pode levar mais de 30 s.
    for (const [id, peer] of this.peers) {
      // Conta a partir de quando já existe oferta/resposta e a conexão ainda não achou caminho
      // (com a rede travada ela pode ficar em "new" sem nem passar para "checking").
      const negotiating =
        peer.pc.remoteDescription && (peer.pc.connectionState === 'new' || peer.pc.connectionState === 'connecting');
      if (!negotiating) peer.checkingSince = 0;
      else peer.checkingSince ||= now;
      const stuck = peer.checkingSince && now - peer.checkingSince > 8000;
      if (stuck && now - peer.lastIceRestart > 12000 && peer.iceRestarts < 3) {
        peer.iceRestarts++;
        peer.lastIceRestart = now;
        peer.checkingSince = now;
        console.info('[nimbo] rota nova para', id.slice(0, 5), 'tentativa', peer.iceRestarts);
        peer.pc.restartIce();
      }
    }
    const waiting = Object.keys(this.broadcasts).filter(
      (id) =>
        id !== this.uid &&
        this.members.includes(id) &&
        !this.failed.has(id) &&
        !Object.keys(this.remote[id] || {}).length &&
        !this.nativeIn.has(id),
    );
    if (!waiting.length) this.autoResyncs = 0;
    for (const id of Object.keys(this.missingSince)) if (!waiting.includes(id)) delete this.missingSince[id];
    for (const id of waiting) this.missingSince[id] ??= now;
    // Logo depois de entrar: 6 s sem a live e a primeira reconexão não espera o intervalo.
    const early = now - this.sessionStart < 30000;
    const stuck = waiting.some((id) => now - this.missingSince[id] > (early ? 6000 : 20000));
    const gap = early && this.autoResyncs === 0 ? 0 : 45000;
    if (stuck && now - this.lastResync > gap && this.autoResyncs < 3) {
      this.autoResyncs++;
      void this.resync();
    }
  }

  // Para suporte: no console do navegador, rode nimboDebug().
  async diagnostics(): Promise<PeerDiagnostics[]> {
    return Promise.all(
      [...this.peers.entries()].map(async ([id, { pc }]) => {
        const stats = await pc.getStats();
        const byId = new Map<string, Record<string, unknown>>();
        stats.forEach((r) => byId.set(r.id, r as Record<string, unknown>));
        let route = 'nenhuma';
        let videoBytesIn = 0;
        let videoBytesOut = 0;
        let framesIn = 0;
        // Tipos de caminho que cada lado ofereceu (host = rede local, srflx = internet direta,
        // relay = servidor TURN) e como foram os testes de pares: mostram se a rede bloqueia P2P.
        const localTypes = new Set<string>();
        const remoteTypes = new Set<string>();
        const pairs: Record<string, number> = {};
        const encoders = new Set<string>();
        stats.forEach((r: Record<string, unknown>) => {
          if (r.type === 'local-candidate') localTypes.add(`${r.candidateType}/${r.protocol}`);
          if (r.type === 'remote-candidate') remoteTypes.add(`${r.candidateType}/${r.protocol}`);
          if (r.type === 'candidate-pair') pairs[String(r.state)] = (pairs[String(r.state)] || 0) + 1;
        });
        stats.forEach((r: Record<string, unknown>) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
            const local = byId.get(r.localCandidateId as string);
            const remote = byId.get(r.remoteCandidateId as string);
            route = `${local?.candidateType}/${local?.protocol} -> ${remote?.candidateType}`;
          }
          if (r.kind === 'video' && r.type === 'inbound-rtp') {
            videoBytesIn += Number(r.bytesReceived || 0);
            framesIn += Number(r.framesDecoded || 0);
          }
          if (r.kind === 'video' && r.type === 'outbound-rtp') {
            videoBytesOut += Number(r.bytesSent || 0);
            if (r.encoderImplementation) encoders.add(`${String(r.encoderImplementation).slice(0, 40)}${r.powerEfficientEncoder ? ' (placa de vídeo)' : ''}`);
          }
        });
        return {
          peer: id.slice(0, 5),
          connection: pc.connectionState,
          ice: pc.iceConnectionState,
          signaling: pc.signalingState,
          route,
          videoBytesIn,
          videoBytesOut,
          framesIn,
          localCandidates: [...localTypes].join(' ') || 'nenhum',
          remoteCandidates: [...remoteTypes].join(' ') || 'nenhum',
          pairs: Object.entries(pairs).map(([k, v]) => `${k}:${v}`).join(' ') || 'nenhum',
          iceRestarts: this.peers.get(id)?.iceRestarts || 0,
          encoder: [...encoders].join(', ') || 'nenhum',
        };
      }),
    );
  }

  async startBroadcast(stream: MediaStream, kind: StreamKind, bitrate: number) {
    if (this.locals.has(kind)) await this.stopBroadcast(kind);
    let announced = this.announced.get(kind);
    if (!announced) this.announced.set(kind, (announced = new MediaStream()));
    // Com a captura já ativa, descobre se dá para codificar pela placa de vídeo (ver hwcodec.ts).
    // A resposta fica guardada: só a primeira live da semana espera o teste (até ~4 s).
    if (!isNativeLive(stream)) this.hardware = await hardwareH264();
    this.locals.set(kind, { stream, announced, bitrate, startedAt: Date.now() });
    this.watchEnded(stream, kind);
    try {
      await this.publishStream(kind);
    } catch (e) {
      await this.stopBroadcast(kind);
      throw e;
    }
    // Live nativa não usa a conexão do navegador: quem assiste é que procura o motor.
    if (!isNativeLive(stream))
      for (const id of this.members) if (id !== this.uid) this.syncSenders(this.ensurePeer(id), kind);
    this.emit();
  }

  // O usuário clicou em "Parar compartilhamento" na barra do navegador.
  private watchEnded(stream: MediaStream, kind: StreamKind) {
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.locals.get(kind)?.stream === stream) void this.stopBroadcast(kind);
    });
  }

  // Troca a fonte (outra tela ou janela) sem encerrar a live: só a faixa enviada muda, então quem
  // assiste continua no mesmo player, sem renegociar o vídeo.
  async replaceSource(kind: StreamKind, stream: MediaStream, bitrate: number) {
    const live = this.locals.get(kind);
    if (!live) return this.startBroadcast(stream, kind, bitrate);
    const old = live.stream;
    live.stream = stream;
    live.bitrate = bitrate;
    live.paused = false;
    this.watchEnded(stream, kind);
    for (const peer of this.peers.values()) this.syncSenders(peer, kind);
    // Live nativa: a captura já trocou de fonte no motor; só a prévia antiga é fechada.
    releaseNativePreview(old);
    old.getTracks().forEach((t) => t.stop());
    this.emit();
  }

  // Encerra a live só se ela ainda for desta captura (o jogo fechou depois de uma troca de fonte).
  async stopIfCurrent(kind: StreamKind, stream: MediaStream) {
    if (this.locals.get(kind)?.stream === stream) await this.stopBroadcast(kind);
  }

  // O jogo transmitido saiu (ou voltou) para a frente. Vale só para a live atual desse tipo.
  setPaused(kind: StreamKind, stream: MediaStream, paused: boolean) {
    const live = this.locals.get(kind);
    if (!live || live.stream !== stream || Boolean(live.paused) === paused) return;
    live.paused = paused;
    for (const peer of this.peers.values()) this.syncSenders(peer, kind);
    this.emit();
  }

  async stopBroadcast(kind?: StreamKind) {
    const kinds = kind ? [kind] : [...this.locals.keys()];
    for (const k of kinds) {
      const live = this.locals.get(k);
      if (!live) continue;
      this.locals.delete(k);
      for (const peer of this.peers.values()) this.syncSenders(peer, k);
      if (isNativeLive(live.stream)) {
        this.closeNativeOut((_uid, kind) => kind === k);
        stopNative(live.stream);
      }
      live.stream.getTracks().forEach((t) => t.stop());
      this.emit();
      await remove(this.path(`streams/${this.uid}/${k}`)).catch(() => {});
    }
  }

  async leave() {
    await this.stopBroadcast();
    this.pause?.stop();
    this.pause = null;
    this.joined = false;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.nativeIn.closeAll();
    await onDisconnect(this.streamsRef)
      .cancel()
      .catch(() => {});
    await onDisconnect(this.memberRef)
      .cancel()
      .catch(() => {});
    await remove(this.memberRef).catch(() => {});
    this.emit();
    this.closed = true;
  }

  // Encerramento síncrono para fechamento da aba: o onDisconnect cuida do banco.
  dispose() {
    this.closed = true;
    this.pause?.stop();
    this.unsubs.forEach((u) => u());
    for (const live of this.locals.values()) {
      if (isNativeLive(live.stream)) stopNative(live.stream);
      live.stream.getTracks().forEach((t) => t.stop());
    }
    this.nativeIn.closeAll();
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear();
  }
}
