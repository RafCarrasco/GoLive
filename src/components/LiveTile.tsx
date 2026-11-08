import { useEffect, useRef, useState } from 'react';
import {
  ClipboardCopy,
  ImageOff,
  LoaderCircle,
  Maximize,
  Minimize,
  RotateCw,
  Video,
  Volume1,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from 'lucide-react';
import { desktop } from '../desktop';
import { APP_VERSION } from '../lib/version';

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
  onSelect,
  selected,
  onRetry,
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
  // Clique na live: destacar (ou voltar para a grade, se já for a destacada).
  onSelect?: () => void;
  selected?: boolean;
  onRetry?: () => void;
  compact?: boolean;
  style?: React.CSSProperties;
}) {
  const tile = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  // Ter um stream não basta: só consideramos a live no ar quando chegam quadros de vídeo.
  const [hasFrames, setHasFrames] = useState(false);
  const [slow, setSlow] = useState(false);
  const [copied, setCopied] = useState(false);
  // Estado das conexões (rota, bytes e quadros) para colar a quem cuida do Nimbo quando uma live trava.
  const copyDiagnostics = async () => {
    const debug = (window as unknown as { nimboDebug?: () => Promise<unknown> }).nimboDebug;
    const report = {
      quando: new Date().toISOString(),
      app: APP_VERSION || 'navegador',
      live: name,
      estado: state,
      quadros: hasFrames,
      conexoes: (await debug?.().catch(() => null)) ?? [],
    };
    await navigator.clipboard.writeText(JSON.stringify(report, null, 1)).catch(() => {});
    setCopied(true);
  };
  // A própria prévia nunca toca áudio: evita que o som capturado volte para a captura (eco).
  const silent = own || muted;

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.srcObject = stream;
    const sync = () => setHasAudio(Boolean(stream?.getAudioTracks().length));
    sync();
    const frames = () => setHasFrames(v.videoWidth > 0 && v.readyState >= 2);
    frames();
    v.addEventListener('loadeddata', frames);
    v.addEventListener('resize', frames);
    v.addEventListener('emptied', frames);
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), own ? 8000 : 15000);
    stream?.addEventListener('addtrack', sync);
    stream?.addEventListener('removetrack', sync);
    return () => {
      clearTimeout(timer);
      v.removeEventListener('loadeddata', frames);
      v.removeEventListener('resize', frames);
      v.removeEventListener('emptied', frames);
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
  // A faixa chegou (a conexão funciona), mas nenhum quadro: a captura de quem transmite está vazia,
  // típico de jogo em tela cheia exclusiva capturado como janela.
  const noImage = state === 'playing' && !hasFrames && slow && !camera;
  const VolumeIcon = silent || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  return (
    <section
      ref={tile}
      className={
        'live-tile' +
        (compact ? ' compact' : '') +
        (onSelect ? ' selectable' : '') +
        (selected ? ' selected' : '') +
        (own && camera ? ' mirror' : '')
      }
      style={style}
      title={onSelect && !fullscreen ? (selected ? 'Voltar para a grade' : 'Destacar esta live') : undefined}
      onClick={(e) => {
        // Cliques nos controles (volume, tela cheia, fechar) não mudam o destaque.
        if ((e.target as HTMLElement).closest('button, input')) return;
        if (!fullscreen) onSelect?.();
      }}
    >
      <video ref={video} autoPlay playsInline muted={silent} />
      {(state !== 'playing' || !hasFrames) && (
        <div className="tile-placeholder">
          {state === 'failed' ? (
            <WifiOff size={28} />
          ) : noImage ? (
            <ImageOff size={28} />
          ) : (
            <LoaderCircle size={28} className="spin" />
          )}
          <span>
            {state === 'failed'
              ? 'Não foi possível conectar a esta live'
              : noImage
                ? own
                  ? 'Sua captura não está gerando imagem'
                  : 'Conectado, mas sem imagem desta transmissão'
                : slow
                  ? 'A conexão está demorando…'
                  : 'Conectando à transmissão…'}
          </span>
          {noImage && !compact && (
            <small className="tile-hint">
              {own
                ? desktop
                  ? 'Jogo em tela cheia não aparece na captura de janela. Troque a fonte (botão ao lado de Encerrar) e escolha a tela inteira; no app atualizado, escolher o jogo já faz isso.'
                  : 'Jogo em tela cheia não aparece na captura de janela. Troque a fonte e escolha a tela inteira, ou use o app do Nimbo para Windows.'
                : 'O problema é na captura de quem transmite. Se for um jogo em tela cheia, peça para transmitir a tela inteira.'}
            </small>
          )}
          {!compact && (state === 'failed' || slow) && (
            <div className="tile-actions">
              {!own && onRetry && (
                <button className="button ghost" onClick={onRetry}>
                  <RotateCw size={15} /> Tentar de novo
                </button>
              )}
              <button className="button ghost" onClick={() => void copyDiagnostics()}>
                <ClipboardCopy size={15} /> {copied ? 'Copiado' : 'Copiar diagnóstico'}
              </button>
            </div>
          )}
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
        <div className="tile-controls">
          {!own && !hasAudio && !camera && (
            <span
              className="no-audio"
              title="Quem transmite não enviou som. No navegador, é preciso marcar 'Compartilhar áudio' ao escolher a tela; no app do Nimbo o som vai pela opção de áudio."
            >
              <VolumeX size={16} aria-hidden /> Sem som
            </span>
          )}
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
