import {
  Link,
  LoaderCircle,
  LogOut,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Settings,
  Settings2,
  Signal,
  Video,
  VideoOff,
  WifiOff,
} from 'lucide-react';
import type { StreamKind } from '../live/capture';

// Rodapé da barra lateral: conexão com o canal, controles de transmissão e conta.
export function UserPanel({
  channelName,
  joined,
  online,
  liveKind,
  busy,
  nickname,
  roleLabel,
  onLeave,
  onToggle,
  onStreamSettings,
  onInvite,
  onProfile,
  onSignOut,
}: {
  channelName: string;
  joined: boolean;
  online: boolean;
  liveKind: StreamKind | null;
  busy: '' | 'joining' | 'starting';
  nickname: string;
  roleLabel: string;
  onLeave: () => void;
  onToggle: (kind: StreamKind) => void;
  onStreamSettings: () => void;
  onInvite: () => void;
  onProfile: () => void;
  onSignOut: () => void;
}) {
  const ScreenIcon = liveKind === 'screen' ? ScreenShareOff : ScreenShare;
  const CameraIcon = liveKind === 'camera' ? VideoOff : Video;
  return (
    <footer className="user-panel">
      {joined && (
        <div className="voice-panel">
          <div className="connection-row">
            <span className={'connection ' + (online ? (liveKind ? 'live' : 'ok') : 'offline')}>
              {online ? <Signal size={16} /> : <WifiOff size={16} />}
            </span>
            <div className="connection-text">
              <strong>{!online ? 'Reconectando…' : liveKind ? 'Ao vivo' : 'Conectado'}</strong>
              <small>{channelName}</small>
            </div>
            <button
              className="icon-button"
              title="Copiar convite"
              aria-label="Copiar convite"
              onClick={onInvite}
            >
              <Link size={16} />
            </button>
            <button
              className="icon-button danger"
              title="Sair do canal"
              aria-label="Sair do canal"
              onClick={onLeave}
            >
              <PhoneOff size={16} />
            </button>
          </div>
          <div className="stream-buttons">
            <button
              className={'stream-button' + (liveKind === 'camera' ? ' live' : '')}
              disabled={busy !== ''}
              aria-pressed={liveKind === 'camera'}
              title={liveKind === 'camera' ? 'Desligar webcam' : 'Ligar webcam'}
              onClick={() => onToggle('camera')}
            >
              <CameraIcon size={18} />
              <span>Webcam</span>
            </button>
            <button
              className={'stream-button' + (liveKind === 'screen' ? ' live' : '')}
              disabled={busy !== ''}
              aria-pressed={liveKind === 'screen'}
              title={liveKind === 'screen' ? 'Encerrar transmissão' : 'Compartilhar tela'}
              onClick={() => onToggle('screen')}
            >
              {busy === 'starting' ? <LoaderCircle size={18} className="spin" /> : <ScreenIcon size={18} />}
              <span>{liveKind === 'screen' ? 'Encerrar' : 'Tela'}</span>
            </button>
            <button
              className="stream-button square"
              title="Configurações da transmissão"
              aria-label="Configurações da transmissão"
              onClick={onStreamSettings}
            >
              <Settings2 size={18} />
            </button>
          </div>
        </div>
      )}
      <div className="account-row">
        <span className="avatar">{(nickname || '?').slice(0, 1).toUpperCase()}</span>
        <div className="account-text">
          <strong>{nickname}</strong>
          <small>{roleLabel}</small>
        </div>
        <button className="icon-button" title="Editar perfil" aria-label="Editar perfil" onClick={onProfile}>
          <Settings size={16} />
        </button>
        <button className="icon-button" title="Sair da conta" aria-label="Sair da conta" onClick={onSignOut}>
          <LogOut size={16} />
        </button>
      </div>
    </footer>
  );
}
