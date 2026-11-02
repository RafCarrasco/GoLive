import { useState } from 'react';
import { desktop } from '../desktop';
import { playSound, setSoundsEnabled, soundsEnabled } from '../lib/sounds';
import { Check, LoaderCircle } from 'lucide-react';
import { Modal } from '../ui/Modal';
import {
  accessLabel,
  nicknameError,
  NICKNAME_MAX,
  ROLE_SLOTS,
  type AccessLevel,
  type RoleDef,
} from '../community';
import { supportsOwnAudioRestriction, type CaptureSettings } from '../live/capture';

function SoundsOption() {
  const [on, setOn] = useState(soundsEnabled);
  const choose = (value: boolean) => {
    setSoundsEnabled(value);
    setOn(value);
    if (value) playSound('join');
  };
  return (
    <div className="option-group">
      <span className="option-label">Avisos sonoros</span>
      <div className="segmented wide">
        <button className={on ? 'on' : ''} onClick={() => choose(true)}>
          Ligados
        </button>
        <button className={on ? '' : 'on'} onClick={() => choose(false)}>
          Desligados
        </button>
      </div>
      <small className="muted">Quando alguém entra ou sai do canal e quando uma live começa.</small>
    </div>
  );
}

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
              ? desktop
                ? 'Escolha um aplicativo no seletor: só o som dele vai para a live.'
                : 'Envia apenas o som da janela escolhida, quando o navegador permite.'
              : 'Somente vídeo.'}
        </small>
      </div>
      <SoundsOption />
      <small className="muted">
        Cada pessoa assistindo usa parte do seu upload. Com muitos espectadores, 720p ou 30 FPS deixam a live
        mais estável.
      </small>
    </Modal>
  );
}

export function PermissionModal({
  title,
  kind,
  current,
  allowOwner,
  roleDefs,
  selectedRoles,
  canEditRoles,
  onSave,
  onSaveRoles,
  onClose,
}: {
  title: string;
  kind: 'category' | 'channel';
  current: AccessLevel;
  allowOwner: boolean;
  roleDefs: Record<string, RoleDef>;
  selectedRoles: string[];
  canEditRoles: boolean;
  onSave: (level: AccessLevel) => Promise<void>;
  onSaveRoles: (roleIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const roles = Object.entries(roleDefs).sort((a, b) => a[1].createdAt - b[1].createdAt);
  const save = (key: string, action: Promise<void>) => {
    setSaving(key);
    void action.finally(() => setSaving(null));
  };
  return (
    <Modal title={title} kicker="QUEM PODE VER E ENTRAR" size="sm" onClose={onClose}>
      <div className="option-group">
        <span className="option-label">Nível mínimo</span>
        <div className="choice-list">
          {(['member', 'admin', 'owner'] as AccessLevel[]).map((level) => {
            const locked = !allowOwner && (level === 'owner' || current === 'owner');
            return (
              <button
                key={level}
                className={'choice' + (current === level ? ' on' : '')}
                disabled={saving !== null || locked}
                title={locked ? 'Somente o proprietário altera esta opção' : undefined}
                onClick={() => save(level, onSave(level))}
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
      </div>
      <div className="option-group">
        <span className="option-label">Cargos com acesso</span>
        {roles.length === 0 ? (
          <small className="muted">
            Crie cargos (grupos de amigos) em Gerenciar comunidade → Cargos para separar quem vê cada{' '}
            {kind === 'category' ? 'categoria' : 'canal'}.
          </small>
        ) : (
          <>
            <div className="role-chips">
              {roles.map(([roleId, def]) => {
                const on = selectedRoles.includes(roleId);
                const full = !on && selectedRoles.length >= ROLE_SLOTS;
                return (
                  <button
                    key={roleId}
                    className={'role-chip' + (on ? ' on' : '')}
                    style={{ '--role': def.color } as React.CSSProperties}
                    aria-pressed={on}
                    disabled={!canEditRoles || saving !== null || full}
                    title={full ? `No máximo ${ROLE_SLOTS} cargos` : undefined}
                    onClick={() =>
                      save(
                        'roles',
                        onSaveRoles(
                          on ? selectedRoles.filter((r) => r !== roleId) : [...selectedRoles, roleId],
                        ),
                      )
                    }
                  >
                    <span className="role-dot" />
                    {def.name}
                  </button>
                );
              })}
            </div>
            <small className="muted">
              {selectedRoles.length
                ? `Só quem tem um dos cargos marcados vê ${kind === 'category' ? 'esta categoria e os canais dela' : 'este canal'}. Os demais nem sabem que existe.`
                : 'Nenhum cargo marcado: todos os membros veem.'}
              {!canEditRoles && ' Somente o proprietário altera os cargos.'}
            </small>
          </>
        )}
      </div>
      <small className="muted">
        Administradores veem tudo. Canais seguem a categoria e podem ser ainda mais restritos. O acesso é
        verificado pelo servidor.
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
