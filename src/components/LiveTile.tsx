import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Maximize, Minimize, Video, Volume1, Volume2, VolumeX, WifiOff, X } from 'lucide-react';

export type TileState = 'playing' | 'connecting' | 'failed';

export function LiveTile({
  name,
  stream,
  own,
  camera,
  state,
  volume,
  muted,
  onVolume,
  onMute,
  onClose,
  onFocus,
  compact,
  style,
}: {
  name: string;
  stream: MediaStream | null;
  own: boolean;
  camera: boolean;
  state: TileState;
  volume: number;
  muted: boolean;
  onVolume: (value: number) => void;
  onMute: (value: boolean) => void;
  onClose: () => void;
  onFocus?: () => void;
  compact?: boolean;
  style?: React.CSSProperties;
}) {
  const tile = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  // A própria prévia nunca toca áudio: evita que o som capturado volte para a captura (eco).
  const silent = own || muted;

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.srcObject = stream;
    const sync = () => setHasAudio(Boolean(stream?.getAudioTracks().length));
    sync();
    stream?.addEventListener('addtrack', sync);
    stream?.addEventListener('removetrack', sync);
    return () => {
      stream?.removeEventListener('addtrack', sync);
      stream?.removeEventListener('removetrack', sync);
      v.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = silent;
    v.volume = Math.min(1, Math.max(0, volume / 100));
    if (v.srcObject && v.paused)
      v.play().catch((e: DOMException) => {
        // Sem interação prévia o navegador só permite autoplay sem som.
        if (e.name === 'NotAllowedError' && !silent) onMute(true);
      });
  }, [silent, volume, stream, onMute]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === tile.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void tile.current?.requestFullscreen().catch(() => {});
  };
  const VolumeIcon = silent || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  return (
    <section
      ref={tile}
      className={'live-tile' + (compact ? ' compact' : '') + (own ? ' own' : '')}
      style={style}
      onDoubleClick={compact ? undefined : toggleFullscreen}
      onClick={compact ? onFocus : undefined}
    >
      <video ref={video} autoPlay playsInline muted={silent} />
      {state !== 'playing' && (
        <div className="tile-placeholder">
          {state === 'failed' ? <WifiOff size={28} /> : <LoaderCircle size={28} className="spin" />}
          <span>
            {state === 'failed' ? 'Não foi possível conectar a esta live' : 'Conectando à transmissão…'}
          </span>
        </div>
      )}
      <div className="tile-top">
        <span className="live-badge">AO VIVO</span>
        <span className="tile-name">
          {camera && <Video size={14} aria-label="Webcam" />}
          {name}
        </span>
        {!compact && (
          <button
            className="tile-button"
            aria-label="Fechar visualização"
            title="Fechar visualização"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        )}
      </div>
      {!compact && (
        <div className="tile-controls" onDoubleClick={(e) => e.stopPropagation()}>
          {!own && hasAudio && (
            <div className="volume">
              <button
                className="tile-button"
                aria-label={silent ? 'Ativar som' : 'Silenciar'}
                title={silent ? 'Ativar som' : 'Silenciar'}
                onClick={() => onMute(!muted)}
              >
                <VolumeIcon size={18} />
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={silent ? 0 : volume}
                aria-label={'Volume de ' + name}
                style={{ '--fill': (silent ? 0 : volume) + '%' } as React.CSSProperties}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  onVolume(value);
                  if (value > 0 && muted) onMute(false);
                }}
              />
              <span className="volume-value">{silent ? 0 : volume}%</span>
            </div>
          )}
          {own && <span className="tile-hint">Sua prévia não reproduz áudio</span>}
          <button
            className="tile-button push-right"
            aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
            title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
          </button>
        </div>
      )}
    </section>
  );
}
