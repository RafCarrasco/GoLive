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
import type { StreamKind } from './capture';

// Sinalização: rooms/{room}/signals/{destinatário}/{remetente}/{id}
type Signal =
  | { type: 'offer' | 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit };

// Cada pessoa pode ter até duas lives: tela e câmera. streamId é o id do MediaStream anunciado na
// negociação; é como quem assiste sabe qual stream recebido é a tela e qual é a câmera.
export type Broadcast = { startedAt: number; streamId: string };
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
};

type Peer = {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  candidates: RTCIceCandidateInit[];
  transceivers: Partial<Record<StreamKind, RTCRtpTransceiver[]>>;
  queue: Promise<void>;
};

type LocalLive = {
  // Stream atual (muda ao trocar de tela) e o anunciado na negociação (fixo enquanto a live durar).
  stream: MediaStream;
  announced: MediaStream;
  bitrate: number;
  startedAt: number;
};

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

// Confere se o TURN configurado responde: força uma conexão só por relay e espera um candidato dele.
export async function testTurn(timeoutMs = 8000) {
  if (!turnUrls.length) return { configured: false, works: false };
  const pc = new RTCPeerConnection({ ...ICE, iceTransportPolicy: 'relay' });
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
  private unsubs: Array<() => void> = [];
  private seen = new Set<string>();
  private joined = false;
  private online = true;
  private closed = false;
  // Desde quando cada live anunciada está sem chegar, e quando foi a última reconexão completa.
  private missingSince: Record<string, number> = {};
  private lastResync = 0;
  private autoResyncs = 0;

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
      remote: Object.fromEntries(Object.entries(this.remote).map(([id, streams]) => [id, { ...streams }])),
      failed: [...this.failed],
    };
  }
  private emit() {
    if (!this.closed) this.onChange(this.snapshot());
  }

  async join() {
    const members = (await get(this.path('members'))).val() as Record<string, unknown> | null;
    if (Object.keys(members || {}).length >= MAX_MEMBERS && !members?.[this.uid]) throw Error('Canal cheio');
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
    for (const kind of this.locals.keys()) await this.publishStream(kind);
  }

  private async publishStream(kind: StreamKind) {
    const live = this.locals.get(kind);
    if (!live) return;
    await onDisconnect(this.streamsRef).remove();
    await set(this.path(`streams/${this.uid}/${kind}`), {
      startedAt: live.startedAt,
      streamId: live.announced.id,
    });
  }

  private listen() {
    let wasOffline = false;
    const watchdog = setInterval(() => this.checkMissing(), 5000);
    this.unsubs.push(() => clearInterval(watchdog));
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
    // Quem transmite inicia a conexão com quem chega; quem só assiste espera a oferta.
    if (this.locals.size) for (const id of ids) if (id !== this.uid) this.ensurePeer(id);
    // Sinais que chegaram antes da lista de membros ficam guardados até aqui.
    if (firstLoad && this.pendingInbox) this.onInbox(this.pendingInbox);
    this.emit();
  }

  private onBroadcasts(raw: unknown) {
    const next = parseBroadcasts(raw);
    // As faixas remotas não são descartadas aqui: elas podem chegar antes do registro da live.
    // A interface só exibe quem está em broadcasts, e o removetrack/closePeer limpa o resto.
    this.broadcasts = next;
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
        const peer = this.ensurePeer(sender);
        // Uma fila por participante: oferta, resposta e candidatos são aplicados na ordem de chegada.
        peer.queue = peer.queue
          .then(() => this.handle(sender, peer, msg))
          .catch((e) => console.warn('[nimbo] sinal', sender, e))
          .finally(() => void discard());
      }
  }

  private send(to: string, msg: Signal) {
    return push(this.path(`signals/${to}/${this.uid}`), clean(msg)).then(() => undefined);
  }

  private ensurePeer(id: string): Peer {
    const existing = this.peers.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection(ICE);
    // "Perfect negotiation": em colisão de ofertas, o lado educado cede e o outro mantém a sua.
    const peer: Peer = {
      pc,
      polite: this.uid > id,
      makingOffer: false,
      ignoreOffer: false,
      candidates: [],
      transceivers: {},
      queue: Promise.resolve(),
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
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };
    pc.onconnectionstatechange = () => {
      console.info('[nimbo] conexão', id.slice(0, 5), pc.connectionState);
      if (pc.connectionState === 'connected') this.failed.delete(id);
      else if (pc.connectionState === 'failed') this.failed.add(id);
      else return;
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
    for (const kind of this.locals.keys()) this.attachLocal(peer, kind);
    return peer;
  }

  private attachLocal(peer: Peer, kind: StreamKind) {
    const live = this.locals.get(kind);
    if (!live || peer.transceivers[kind]?.length) return;
    peer.transceivers[kind] = live.stream.getTracks().map((track) =>
      peer.pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [live.announced],
        sendEncodings: track.kind === 'video' ? [{ maxBitrate: live.bitrate }] : undefined,
      }),
    );
  }

  private detachLocal(peer: Peer, kind: StreamKind) {
    // stop() libera as m-lines e faz o outro lado remover apenas esta faixa: a outra live nossa e as
    // de outras pessoas que chegam pela mesma conexão continuam intactas.
    for (const t of peer.transceivers[kind] || []) if (t.currentDirection !== 'stopped') t.stop();
    delete peer.transceivers[kind];
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
    const waiting = Object.keys(this.broadcasts).filter(
      (id) =>
        id !== this.uid &&
        this.members.includes(id) &&
        !this.failed.has(id) &&
        !Object.keys(this.remote[id] || {}).length,
    );
    if (!waiting.length) this.autoResyncs = 0;
    for (const id of Object.keys(this.missingSince)) if (!waiting.includes(id)) delete this.missingSince[id];
    for (const id of waiting) this.missingSince[id] ??= now;
    const stuck = waiting.some((id) => now - this.missingSince[id] > 20000);
    if (stuck && now - this.lastResync > 45000 && this.autoResyncs < 3) {
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
          if (r.kind === 'video' && r.type === 'outbound-rtp') videoBytesOut += Number(r.bytesSent || 0);
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
        };
      }),
    );
  }

  async startBroadcast(stream: MediaStream, kind: StreamKind, bitrate: number) {
    if (this.locals.has(kind)) await this.stopBroadcast(kind);
    this.locals.set(kind, { stream, announced: stream, bitrate, startedAt: Date.now() });
    this.watchEnded(stream, kind);
    try {
      await this.publishStream(kind);
    } catch (e) {
      await this.stopBroadcast(kind);
      throw e;
    }
    for (const id of this.members) if (id !== this.uid) this.attachLocal(this.ensurePeer(id), kind);
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
    this.watchEnded(stream, kind);
    const next = { video: stream.getVideoTracks()[0] || null, audio: stream.getAudioTracks()[0] || null };
    for (const peer of this.peers.values()) {
      const transceivers = peer.transceivers[kind] || [];
      for (const trackKind of ['video', 'audio'] as const) {
        const existing = transceivers.find(
          (t) => t.receiver.track.kind === trackKind && t.currentDirection !== 'stopped',
        );
        const track = next[trackKind];
        if (existing) await existing.sender.replaceTrack(track).catch(() => {});
        else if (track)
          transceivers.push(
            peer.pc.addTransceiver(track, { direction: 'sendonly', streams: [live.announced] }),
          );
      }
      peer.transceivers[kind] = transceivers;
    }
    old.getTracks().forEach((t) => t.stop());
    this.emit();
  }

  async stopBroadcast(kind?: StreamKind) {
    const kinds = kind ? [kind] : [...this.locals.keys()];
    for (const k of kinds) {
      const live = this.locals.get(k);
      if (!live) continue;
      this.locals.delete(k);
      for (const peer of this.peers.values()) this.detachLocal(peer, k);
      live.stream.getTracks().forEach((t) => t.stop());
      this.emit();
      await remove(this.path(`streams/${this.uid}/${k}`)).catch(() => {});
    }
  }

  async leave() {
    await this.stopBroadcast();
    this.joined = false;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    for (const id of [...this.peers.keys()]) this.closePeer(id);
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
    this.unsubs.forEach((u) => u());
    for (const live of this.locals.values()) live.stream.getTracks().forEach((t) => t.stop());
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear();
  }
}
