import { useCallback, useEffect, useRef, useState } from 'react';
import { db, useEmulators } from '../firebase';
import { LiveRoom, type LiveSnapshot } from '../live/room';
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
  local: null,
  localKind: null,
  remote: {},
  failed: [],
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

  const start = useCallback(async (kind: StreamKind, settings: CaptureSettings) => {
    const room = current.current;
    if (!room) return;
    setBusy('starting');
    try {
      const stream =
        new URLSearchParams(location.search).has('fakeMedia') && useEmulators
          ? createTestStream(
              `${new URLSearchParams(location.search).get('devUser') || 'Teste'} · ${kind === 'camera' ? 'Webcam' : 'Tela'}`,
              settings.frameRate,
            )
          : kind === 'camera'
            ? await captureCamera(settings)
            : await captureScreen(settings);
      if (current.current !== room) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      await room.startBroadcast(stream, kind, maxBitrate(kind, settings));
    } finally {
      setBusy('');
    }
  }, []);

  const stop = useCallback(async () => {
    await current.current?.stopBroadcast();
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

  return { snapshot, busy, join, leave, start, stop };
}

function keepDevParams(prefix = '?') {
  if (!useEmulators) return '';
  const params = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  for (const key of ['devUser', 'fakeMedia']) if (params.has(key)) keep.set(key, params.get(key)!);
  const text = keep.toString();
  return text ? prefix + text : '';
}
