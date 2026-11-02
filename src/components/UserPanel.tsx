import {
  Link,
  LoaderCircle,
  LogOut,
  MonitorUp,
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
import { APP_VERSION, SITE_VERSION } from '../lib/version';

// Rodapé da barra lateral: conexão com o canal, controles de transmissão e conta.
export function UserPanel({
  channelName,
  joined,
  online,
  liveKinds,
  onSwap,
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
  liveKinds: Record<StreamKind, boolean>;
  onSwap: () => void;
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
  const ScreenIcon = liveKinds.screen ? ScreenShareOff : ScreenShare;
  const CameraIcon = liveKinds.camera ? VideoOff : Video;
  const live = liveKinds.screen || liveKinds.camera;
  return (
    <footer className="user-panel">
      {joined && (
        <div className="voice-panel">
          <div className="connection-row">
            <span className={'connection ' + (online ? (live ? 'live' : 'ok') : 'offline')}>
              {online ? <Signal size={16} /> : <WifiOff size={16} />}
            </span>
            <div className="connection-text">
              <strong>{!online ? 'Reconectando…' : live ? 'Ao vivo' : 'Conectado'}</strong>
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
              className={'stream-button' + (liveKinds.camera ? ' live' : '')}
              disabled={busy !== ''}
              aria-pressed={liveKinds.camera}
              title={liveKinds.camera ? 'Desligar webcam' : 'Ligar webcam'}
              onClick={() => onToggle('camera')}
            >
              <CameraIcon size={18} />
              <span>Webcam</span>
            </button>
            <button
              className={'stream-button' + (liveKinds.screen ? ' live' : '')}
              disabled={busy !== ''}
              aria-pressed={liveKinds.screen}
              title={liveKinds.screen ? 'Encerrar transmissão' : 'Compartilhar tela'}
              onClick={() => onToggle('screen')}
            >
              {busy === 'starting' ? <LoaderCircle size={18} className="spin" /> : <ScreenIcon size={18} />}
              <span>{liveKinds.screen ? 'Encerrar' : 'Tela'}</span>
            </button>
            {liveKinds.screen && (
              <button
                className="stream-button square"
                disabled={busy !== ''}
                title="Trocar tela ou janela sem encerrar a live"
                aria-label="Trocar tela ou janela"
                onClick={onSwap}
              >
                <MonitorUp size={18} />
              </button>
            )}
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
      <div className="version-line">
        Nimbo {SITE_VERSION}
        {APP_VERSION && ` · app ${APP_VERSION}`}
      </div>
    </footer>
  );
}
