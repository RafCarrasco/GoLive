import { useCallback, useEffect, useRef, useState } from 'react';
import { gameWatchOf } from '../desktop';
import { db, useEmulators } from '../firebase';
import { LiveRoom, testTurn, type LiveSnapshot } from '../live/room';
import { isNativeLive, stopNative } from '../live/native';
import {
  captureCamera,
  captureScreen,
  createTestStream,
  maxBitrate,
  type CaptureSettings,
  type StreamKind,
} from '../live/capture';

const EMPTY: LiveSnapshot = {
  room: '',
  joined: false,
  online: true,
  members: [],
  broadcasts: {},
  local: {},
  remote: {},
  failed: [],
  connecting: [],
};

type Handlers = {
  onIssue: (message: string) => void;
  onKicked: (message: string) => void;
};

// Liga o LiveRoom ao React e garante uma única sala ativa por vez (e por usuário entre abas).
export function useLiveRoom(uid: string, handlers: Handlers) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot>(EMPTY);
  const [busy, setBusy] = useState<'' | 'joining' | 'starting'>('');
  const current = useRef<LiveRoom | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const tabId = useRef(Math.random().toString(36).slice(2)).current;
  const channel = useRef<BroadcastChannel | null>(null);

  const leave = useCallback(async () => {
    const room = current.current;
    current.current = null;
    setSnapshot(EMPTY);
    history.replaceState(null, '', location.pathname + keepDevParams());
    await room?.leave();
  }, []);

  const join = useCallback(
    async (roomId: string) => {
      if (current.current?.room === roomId) return;
      setBusy('joining');
      try {
        await leave();
        const room = new LiveRoom(
          db,
          uid,
          roomId,
          (s) => current.current === room && setSnapshot(s),
          (message, fatal) => {
            if (fatal && current.current === room) {
              void leave();
              handlersRef.current.onKicked(message);
            } else handlersRef.current.onIssue(message);
          },
        );
        current.current = room;
        try {
          await room.join();
        } catch (e) {
          if (current.current === room) current.current = null;
          await room.leave().catch(() => {});
          setSnapshot(EMPTY);
          throw e;
        }
        history.replaceState(null, '', `?room=${encodeURIComponent(roomId)}` + keepDevParams('&'));
        // Mesmo usuário em outra aba: a aba antiga sai do canal para não duplicar presença.
        channel.current?.postMessage({ uid, tabId, room: roomId });
      } finally {
        setBusy('');
      }
    },
    [uid, leave, tabId],
  );

  // replace = trocar a tela/janela de uma live que já está no ar, sem encerrá-la.
  const start = useCallback(async (kind: StreamKind, settings: CaptureSettings, replace = false) => {
    const room = current.current;
    if (!room) return;
    setBusy('starting');
    try {
      const params = new URLSearchParams(location.search);
      const stream =
        params.has('fakeMedia') && useEmulators
          ? createTestStream(
              `${params.get('devUser') || 'Teste'} · ${kind === 'camera' ? 'Webcam' : 'Tela'}${replace ? ' 2' : ''}`,
              settings.frameRate,
            )
          : kind === 'camera'
            ? await captureCamera(settings)
            : await captureScreen(settings);
      if (current.current !== room) {
        // Saiu do canal enquanto a captura abria: no app em Rust é preciso parar o motor também.
        if (isNativeLive(stream)) stopNative(stream);
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (replace) await room.replaceSource(kind, stream, maxBitrate(kind, settings));
      else await room.startBroadcast(stream, kind, maxBitrate(kind, settings));
      const game = gameWatchOf(stream);
      game?.onChange((active) => room.setPaused(kind, stream, !active));
      game?.onEnded(() => {
        void room.stopIfCurrent(kind, stream).then(() => handlersRef.current.onIssue('O jogo fechou e a live foi encerrada.'));
      });
    } finally {
      setBusy('');
    }
  }, []);

  const stop = useCallback(async (kind?: StreamKind) => {
    await current.current?.stopBroadcast(kind);
  }, []);

  const retry = useCallback((id: string) => current.current?.retry(id), []);

  // Suporte no console: nimboDebug() mostra cada conexão P2P; nimboTurnTest() confere o TURN.
  useEffect(() => {
    const w = window as unknown as Record<string, () => Promise<unknown>>;
    w.nimboDebug = async () => {
      const result = (await current.current?.diagnostics()) || [];
      console.table(result);
      return result;
    };
    w.nimboTurnTest = testTurn;
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel('nimbo-session');
    channel.current = bc;
    bc.onmessage = (e: MessageEvent<{ uid: string; tabId: string }>) => {
      if (e.data.uid !== uid || e.data.tabId === tabId || !current.current) return;
      void leave();
      handlersRef.current.onKicked('Você entrou em um canal em outra aba.');
    };
    return () => bc.close();
  }, [uid, tabId, leave]);

  // Troca de conta ou desmontagem: sai do canal. No fechamento da aba o onDisconnect limpa o banco.
  useEffect(() => {
    const onUnload = () => current.current?.dispose();
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      void current.current?.leave();
      current.current = null;
    };
  }, [uid]);

  return { snapshot, busy, join, leave, start, stop, retry };
}

function keepDevParams(prefix = '?') {
  if (!useEmulators) return '';
  const params = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  for (const key of ['devUser', 'fakeMedia']) if (params.has(key)) keep.set(key, params.get(key)!);
  const text = keep.toString();
  return text ? prefix + text : '';
}
