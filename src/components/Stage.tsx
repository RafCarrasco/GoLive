import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LayoutGrid, RectangleHorizontal, Users } from 'lucide-react';
import { LiveTile, type TileState } from './LiveTile';
import type { LiveSnapshot } from '../live/room';
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
}: {
  uid: string;
  channelName: string;
  live: LiveSnapshot;
  visible: string[];
  setVisible: (update: (ids: string[]) => string[]) => void;
  nameOf: (id: string) => string;
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

  // A própria live aparece assim que a captura começa; um registro antigo sem captura local é ignorado.
  const active = [...(live.local ? [uid] : []), ...Object.keys(live.broadcasts).filter((id) => id !== uid)];
  const shown = visible.filter((id) => active.includes(id));
  const toggle = (id: string) =>
    setVisible((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const setPref = useCallback(
    (id: string, patch: Partial<{ volume: number; muted: boolean }>) =>
      setAudio((old) => ({ ...old, [id]: { ...(old[id] ?? { volume: 100, muted: false }), ...patch } })),
    [],
  );

  const main = layout === 'focus' ? shown.find((id) => id === focused) || shown[0] : '';
  const strip = layout === 'focus' ? shown.filter((id) => id !== main) : [];
  const gridIds = layout === 'focus' ? (main ? [main] : []) : shown;
  const stripHeight = strip.length ? 132 : 0;
  const fit = fitGrid(gridIds.length, size.width, size.height - stripHeight - (strip.length ? GAP : 0));

  const tileFor = (id: string, compact = false) => {
    const own = id === uid;
    const stream = own ? live.local : live.remote[id] || null;
    const state: TileState = stream ? 'playing' : live.failed.includes(id) ? 'failed' : 'connecting';
    const pref = audio[id] || { volume: 100, muted: false };
    return (
      <LiveTile
        key={id}
        name={own ? 'Sua live' : nameOf(id)}
        stream={stream}
        own={own}
        camera={(own ? live.localKind : live.broadcasts[id]?.kind) === 'camera'}
        state={state}
        volume={pref.volume}
        muted={pref.muted}
        onVolume={(volume) => setPref(id, { volume })}
        onMute={(muted) => setPref(id, { muted })}
        onClose={() => setVisible((ids) => ids.filter((x) => x !== id))}
        onFocus={() => setFocused(id)}
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
          {active.map((id) => (
            <button
              key={id}
              className={'live-chip' + (visible.includes(id) ? ' on' : '')}
              aria-pressed={visible.includes(id)}
              title={visible.includes(id) ? 'Ocultar live' : 'Assistir live'}
              onClick={() => toggle(id)}
            >
              <span className="dot" />
              {id === uid ? 'Você' : nameOf(id)}
            </button>
          ))}
        </div>
        {shown.length > 1 && (
          <div className="segmented" role="group" aria-label="Layout">
            <button
              className={layout === 'grid' ? 'on' : ''}
              title="Grade"
              aria-label="Grade"
              onClick={() => setLayout('grid')}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              className={layout === 'focus' ? 'on' : ''}
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
              {gridIds.map((id) => tileFor(id))}
            </div>
            {strip.length > 0 && <div className="tile-strip">{strip.map((id) => tileFor(id, true))}</div>}
          </>
        )}
      </div>
    </section>
  );
}
