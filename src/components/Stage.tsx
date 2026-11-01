import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LayoutGrid, RectangleHorizontal, Users, Video } from 'lucide-react';
import { LiveTile, type TileState } from './LiveTile';
import { liveKey, parseLiveKey, type LiveSnapshot } from '../live/room';
import type { StreamKind } from '../live/capture';
import { fitGrid, GAP } from '../lib/layout';

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Medição imediata: o ResizeObserver só notifica no próximo quadro pintado.
    const style = getComputedStyle(el);
    setSize({
      width: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    });
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

type AudioPrefs = Record<string, { volume: number; muted: boolean }>;
const AUDIO_KEY = 'nimbo.audio';
function loadAudio(): AudioPrefs {
  try {
    return JSON.parse(localStorage.getItem(AUDIO_KEY) || '{}');
  } catch {
    return {};
  }
}

export function Stage({
  uid,
  channelName,
  live,
  visible,
  setVisible,
  nameOf,
  onRetry,
}: {
  uid: string;
  channelName: string;
  live: LiveSnapshot;
  visible: string[];
  setVisible: (update: (ids: string[]) => string[]) => void;
  nameOf: (id: string) => string;
  onRetry: (id: string) => void;
}) {
  const [layout, setLayout] = useState<'grid' | 'focus'>('grid');
  const [focused, setFocused] = useState('');
  const [audio, setAudio] = useState<AudioPrefs>(loadAudio);
  const [area, size] = useSize<HTMLDivElement>();

  useEffect(() => {
    try {
      localStorage.setItem(AUDIO_KEY, JSON.stringify(audio));
    } catch {
      // Preferência apenas local.
    }
  }, [audio]);

  // Cada live é "uid:screen" ou "uid:camera". As próprias aparecem assim que a captura começa; um
  // registro antigo no banco sem captura local é ignorado.
  const ownKeys = (Object.keys(live.local) as StreamKind[]).map((kind) => liveKey(uid, kind));
  const otherKeys = Object.entries(live.broadcasts).flatMap(([id, kinds]) =>
    id === uid ? [] : (Object.keys(kinds) as StreamKind[]).map((kind) => liveKey(id, kind)),
  );
  const active = [...ownKeys, ...otherKeys];
  const shown = visible.filter((key) => active.includes(key));
  const toggle = (key: string) =>
    setVisible((keys) => (keys.includes(key) ? keys.filter((x) => x !== key) : [...keys, key]));
  const setPref = useCallback(
    (key: string, patch: Partial<{ volume: number; muted: boolean }>) =>
      setAudio((old) => ({ ...old, [key]: { ...(old[key] ?? { volume: 100, muted: false }), ...patch } })),
    [],
  );

  // Como no Discord: clicar numa live a destaca (as outras vão para a faixa de baixo);
  // clicar na destacada volta para a grade.
  const focusMode = layout === 'focus' && shown.length > 1;
  const main = focusMode ? shown.find((key) => key === focused) || shown[0] : '';
  const strip = focusMode ? shown.filter((key) => key !== main) : [];
  const gridKeys = focusMode ? [main] : shown;
  const stripHeight = strip.length ? 132 : 0;
  const fit = fitGrid(gridKeys.length, size.width, size.height - stripHeight - (strip.length ? GAP : 0));
  const select = (key: string) => {
    if (shown.length < 2) return;
    if (focusMode && key === main) setLayout('grid');
    else {
      setFocused(key);
      setLayout('focus');
    }
  };

  const labelOf = (key: string) => {
    const { uid: id, kind } = parseLiveKey(key);
    if (id === uid) return kind === 'camera' ? 'Sua câmera' : 'Sua tela';
    return nameOf(id);
  };

  const tileFor = (key: string, compact = false) => {
    const { uid: id, kind } = parseLiveKey(key);
    const own = id === uid;
    const streamId = live.broadcasts[id]?.[kind]?.streamId;
    const stream = (own ? live.local[kind] : streamId ? live.remote[id]?.[streamId] : undefined) || null;
    const state: TileState = live.failed.includes(id) ? 'failed' : stream ? 'playing' : 'connecting';
    const pref = audio[key] || { volume: 100, muted: false };
    return (
      <LiveTile
        key={key}
        name={labelOf(key)}
        stream={stream}
        own={own}
        camera={kind === 'camera'}
        state={state}
        volume={pref.volume}
        muted={pref.muted}
        onVolume={(volume) => setPref(key, { volume })}
        onMute={(muted) => setPref(key, { muted })}
        onClose={() => setVisible((keys) => keys.filter((x) => x !== key))}
        onSelect={shown.length > 1 ? () => select(key) : undefined}
        selected={focusMode && key === main}
        onRetry={() => onRetry(id)}
        compact={compact}
        style={compact ? undefined : { width: fit.width, height: fit.height }}
      />
    );
  };

  return (
    <section className="stage">
      <header className="stage-head">
        <div className="stage-title">
          <h1>{channelName}</h1>
          <span className="muted">
            <Users size={14} /> {live.members.length}
          </span>
        </div>
        <div className="live-chips" role="toolbar" aria-label="Lives do canal">
          {active.map((key) => {
            const { uid: id, kind } = parseLiveKey(key);
            return (
              <button
                key={key}
                className={'live-chip' + (visible.includes(key) ? ' on' : '')}
                aria-pressed={visible.includes(key)}
                title={visible.includes(key) ? 'Ocultar live' : 'Assistir live'}
                onClick={() => toggle(key)}
              >
                <span className="dot" />
                {id === uid ? 'Você' : nameOf(id)}
                {kind === 'camera' && <Video size={13} aria-label="câmera" />}
              </button>
            );
          })}
        </div>
        {shown.length > 1 && (
          <div className="segmented" role="group" aria-label="Layout">
            <button
              className={!focusMode ? 'on' : ''}
              title="Grade"
              aria-label="Grade"
              onClick={() => setLayout('grid')}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              className={focusMode ? 'on' : ''}
              title="Destaque"
              aria-label="Destaque"
              onClick={() => setLayout('focus')}
            >
              <RectangleHorizontal size={16} />
            </button>
          </div>
        )}
      </header>
      <div className="stage-area" ref={area}>
        {shown.length === 0 ? (
          <div className="stage-empty">
            <img src="/nimbo-mascot.svg" alt="" />
            <strong>{active.length ? 'Escolha uma live para assistir' : 'Ninguém ao vivo por aqui'}</strong>
            <span className="muted">
              {active.length
                ? 'Clique nos nomes acima ou na barra lateral. Dá para assistir várias ao mesmo tempo.'
                : 'Compartilhe sua tela ou webcam pelos botões no canto inferior esquerdo.'}
            </span>
          </div>
        ) : (
          <>
            <div
              className="tile-grid"
              style={{ width: fit.cols * fit.width + (fit.cols - 1) * GAP + 1, gap: GAP }}
            >
              {gridKeys.map((key) => tileFor(key))}
            </div>
            {strip.length > 0 && <div className="tile-strip">{strip.map((key) => tileFor(key, true))}</div>}
          </>
        )}
      </div>
    </section>
  );
}
