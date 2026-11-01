import { useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { accessLabel, nicknameError, NICKNAME_MAX, type AccessLevel } from '../community';
import { supportsOwnAudioRestriction, type CaptureSettings } from '../live/capture';

export function StreamSettingsModal({
  settings,
  live,
  onChange,
  onClose,
}: {
  settings: CaptureSettings;
  live: boolean;
  onChange: (settings: CaptureSettings) => void;
  onClose: () => void;
}) {
  const set = <K extends keyof CaptureSettings>(key: K, value: CaptureSettings[K]) =>
    onChange({ ...settings, [key]: value });
  return (
    <Modal
      title="Configurações da transmissão"
      kicker="LIVE"
      onClose={onClose}
      footer={
        <button className="button primary" onClick={onClose}>
          Concluído
        </button>
      }
    >
      {live && <p className="notice">As mudanças valem para a próxima transmissão.</p>}
      <div className="option-group">
        <span className="option-label">O que compartilhar</span>
        <div className="segmented wide">
          <button
            className={settings.surface === 'monitor' ? 'on' : ''}
            onClick={() => set('surface', 'monitor')}
          >
            Tela inteira
          </button>
          <button
            className={settings.surface === 'window' ? 'on' : ''}
            onClick={() => set('surface', 'window')}
          >
            Janela
          </button>
        </div>
        <small className="muted">
          Para jogos em tela cheia, prefira Tela inteira ou o modo janela sem bordas.
        </small>
      </div>
      <div className="option-row">
        <div className="option-group">
          <span className="option-label">Resolução</span>
          <div className="segmented wide">
            {([720, 1080] as const).map((q) => (
              <button
                key={q}
                className={settings.quality === q ? 'on' : ''}
                onClick={() => set('quality', q)}
              >
                {q}p
              </button>
            ))}
          </div>
        </div>
        <div className="option-group">
          <span className="option-label">Quadros por segundo</span>
          <div className="segmented wide">
            {([30, 60] as const).map((f) => (
              <button
                key={f}
                className={settings.frameRate === f ? 'on' : ''}
                onClick={() => set('frameRate', f)}
              >
                {f} FPS
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="option-group">
        <span className="option-label">Áudio</span>
        <div className="segmented wide">
          <button className={settings.audio === 'system' ? 'on' : ''} onClick={() => set('audio', 'system')}>
            Computador
          </button>
          <button className={settings.audio === 'window' ? 'on' : ''} onClick={() => set('audio', 'window')}>
            Só a janela
          </button>
          <button className={settings.audio === 'none' ? 'on' : ''} onClick={() => set('audio', 'none')}>
            Sem áudio
          </button>
        </div>
        <small className="muted">
          {settings.audio === 'system'
            ? supportsOwnAudioRestriction()
              ? 'O som das lives que você assiste no Nimbo não é reenviado. Vozes de outros apps (ex.: Discord) entram na live.'
              : 'Seu navegador pode reenviar o som das lives que você assiste. Use fones ou silencie as outras lives.'
            : settings.audio === 'window'
              ? 'Envia apenas o som da janela escolhida, quando o navegador permite.'
              : 'Somente vídeo.'}
        </small>
      </div>
      <small className="muted">
        Cada pessoa assistindo usa parte do seu upload. Com muitos espectadores, 720p ou 30 FPS deixam a live
        mais estável.
      </small>
    </Modal>
  );
}

export function PermissionModal({
  title,
  current,
  allowOwner,
  onSave,
  onClose,
}: {
  title: string;
  current: AccessLevel;
  allowOwner: boolean;
  onSave: (level: AccessLevel) => Promise<void>;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState<AccessLevel | null>(null);
  return (
    <Modal title={title} kicker="QUEM PODE ENTRAR" size="sm" onClose={onClose}>
      <div className="choice-list">
        {(['member', 'admin', 'owner'] as AccessLevel[]).map((level) => {
          const locked = !allowOwner && (level === 'owner' || current === 'owner');
          return (
            <button
              key={level}
              className={'choice' + (current === level ? ' on' : '')}
              disabled={saving !== null || locked}
              title={locked ? 'Somente o proprietário altera esta opção' : undefined}
              onClick={() => {
                setSaving(level);
                void onSave(level).finally(() => setSaving(null));
              }}
            >
              <span>{accessLabel[level]}</span>
              {saving === level ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                current === level && <Check size={16} />
              )}
            </button>
          );
        })}
      </div>
      <small className="muted">
        Canais seguem a restrição da categoria e podem ser ainda mais restritos. O acesso é verificado pelo
        servidor.
      </small>
    </Modal>
  );
}

export function NicknameForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="nickname-form"
      onSubmit={(e) => {
        e.preventDefault();
        const invalid = nicknameError(value);
        if (invalid) return setError(invalid);
        setSaving(true);
        void onSubmit(value.trim())
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setSaving(false));
      }}
    >
      <input
        autoFocus
        maxLength={NICKNAME_MAX}
        aria-label="Seu nickname"
        placeholder="Como seus amigos vão te chamar?"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError('');
        }}
      />
      {error && <p className="field-error">{error}</p>}
      <button className="button primary" type="submit" disabled={saving}>
        {saving && <LoaderCircle size={16} className="spin" />}
        {submitLabel}
      </button>
    </form>
  );
}
