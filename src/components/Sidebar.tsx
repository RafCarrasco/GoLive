import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Lock,
  MonitorPlay,
  Plus,
  Radio,
  Settings,
  Trash2,
  Video,
} from 'lucide-react';
import { categoryAllowed, channelAllowed, isStaff, type AccessLevel } from '../community';
import type { CommunityData, RoomPresence } from '../hooks/useCommunity';

const COLLAPSE_KEY = 'nimbo.collapsed';

export function Sidebar({
  uid,
  data,
  presence,
  room,
  disabled,
  adminOpen,
  onJoin,
  onWatch,
  onOpenAdmin,
  onPermission,
  onCreateChannel,
  onRemoveSession,
  footer,
}: {
  uid: string;
  data: CommunityData;
  presence: Record<string, RoomPresence>;
  room: string;
  disabled: boolean;
  adminOpen: boolean;
  onJoin: (channelId: string) => void;
  onWatch: (channelId: string, memberId: string) => void;
  onOpenAdmin: () => void;
  onPermission: (target: { kind: 'category' | 'channel'; id: string }) => void;
  onCreateChannel: (categoryId: string) => void;
  onRemoveSession: (channelId: string, memberId: string) => void;
  footer: React.ReactNode;
}) {
  const role = data.roles[uid] || 'member';
  const staff = isStaff(role);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
    } catch {
      return {};
    }
  });
  const toggle = (id: string) =>
    setCollapsed((old) => {
      const next = { ...old, [id]: !old[id] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // Preferência apenas local.
      }
      return next;
    });

  const categories = Object.entries(data.categories).sort((a, b) => a[1].order - b[1].order);
  // Texto do cadeado (só a equipe vê itens restritos; os demais nem recebem esses dados).
  const restrictedLabel = (level?: AccessLevel, roleIds?: string[]) =>
    [
      level === 'owner' ? 'Somente proprietário' : level === 'admin' ? 'Somente administradores' : '',
      roleIds?.length ? 'Cargos: ' + roleIds.map((r) => data.roleDefs[r]?.name || 'removido').join(', ') : '',
    ]
      .filter(Boolean)
      .join(' · ');
  // Cor do primeiro cargo da pessoa, como no Discord.
  const colorOf = (memberId: string) => {
    const first = Object.keys(data.memberRoles[memberId] || {}).find((r) => data.roleDefs[r]);
    return first ? data.roleDefs[first].color : undefined;
  };

  return (
    <nav className="sidebar" aria-label="Comunidade">
      <header className="sidebar-head">
        <img className="brand-mark" src="/nimbo-mascot.svg" alt="" />
        <strong>Nimbo</strong>
        {staff && (
          <button
            className={'icon-button' + (adminOpen ? ' on' : '')}
            aria-label="Gerenciar comunidade"
            title="Gerenciar comunidade"
            onClick={onOpenAdmin}
          >
            <Settings size={18} />
          </button>
        )}
      </header>
      <div className="channel-list">
        {categories.map(([categoryId, category]) => {
          const channels = Object.entries(data.channels).filter(
            ([, c]) => c.enabled && (c.categoryId || 'lives') === categoryId,
          );
          const visibleChannels = channels.filter(([id]) => staff || channelAllowed(id, uid, data));
          if (!staff && (!visibleChannels.length || !categoryAllowed(categoryId, uid, data))) return null;
          const isCollapsed = collapsed[categoryId];
          const categoryRestriction = restrictedLabel(
            data.categoryAccess[categoryId],
            data.categoryRoles[categoryId],
          );
          return (
            <div className="category" key={categoryId}>
              <div className="category-row">
                <button
                  className="category-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(categoryId)}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span>{category.name}</span>
                  {categoryRestriction && <Lock size={11} aria-label={categoryRestriction} />}
                </button>
                {staff && (
                  <span className="row-actions">
                    <button
                      className="icon-button tiny"
                      title={'Criar canal em ' + category.name}
                      aria-label={'Criar canal em ' + category.name}
                      onClick={() => onCreateChannel(categoryId)}
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      className="icon-button tiny"
                      title={'Permissões de ' + category.name}
                      aria-label={'Permissões de ' + category.name}
                      onClick={() => onPermission({ kind: 'category', id: categoryId })}
                    >
                      <Settings size={13} />
                    </button>
                  </span>
                )}
              </div>
              {!isCollapsed &&
                visibleChannels.map(([id, channel]) => {
                  const allowed = channelAllowed(id, uid, data);
                  const here = (allowed && presence[id]) || { members: [], streams: {} };
                  const streams = here.streams;
                  const members = here.members.filter((m) => m === uid || data.profiles[m] || staff);
                  const liveCount = members.filter((m) => streams[m]).length;
                  const restriction = restrictedLabel(data.channelAccess[id], data.channelRoles[id]);
                  return (
                    <div className="channel" key={id}>
                      <div
                        className={
                          'channel-row' + (room === id ? ' active' : '') + (allowed ? '' : ' locked')
                        }
                      >
                        <button
                          className="channel-button"
                          disabled={disabled || !allowed}
                          title={allowed ? 'Entrar em ' + channel.name : 'Você não tem acesso a este canal'}
                          onClick={() => onJoin(id)}
                        >
                          {allowed ? <MonitorPlay size={16} /> : <Lock size={15} />}
                          <span className="channel-name">{channel.name}</span>
                          {restriction && allowed && (
                            <Lock size={11} aria-label={restriction} className="muted" />
                          )}
                          {liveCount > 0 && (
                            <span className="live-count" title={`${liveCount} ao vivo`}>
                              <Radio size={11} />
                              {liveCount}
                            </span>
                          )}
                        </button>
                        {staff && (
                          <button
                            className="icon-button tiny row-actions"
                            title={'Permissões do canal ' + channel.name}
                            aria-label={'Permissões do canal ' + channel.name}
                            onClick={() => onPermission({ kind: 'channel', id })}
                          >
                            <Settings size={13} />
                          </button>
                        )}
                      </div>
                      {members.length > 0 && (
                        <ul className="participants">
                          {members.map((memberId) => {
                            const profileName = data.profiles[memberId]?.displayName;
                            const name =
                              memberId === uid && profileName ? profileName + ' (você)' : profileName;
                            const kinds = streams[memberId] || {};
                            const stream = Boolean(kinds.screen || kinds.camera);
                            return (
                              <li key={memberId}>
                                <button
                                  className={'participant' + (stream ? ' is-live' : '')}
                                  disabled={!stream || !allowed}
                                  title={stream ? 'Assistir' : undefined}
                                  onClick={() => onWatch(id, memberId)}
                                >
                                  <span className="avatar small">
                                    {(name || '?').slice(0, 1).toUpperCase()}
                                  </span>
                                  <span className="participant-name" style={{ color: colorOf(memberId) }}>
                                    {name || 'Sessão sem perfil'}
                                  </span>
                                  {stream && (
                                    <span className="live-pill">
                                      {kinds.screen && <Radio size={10} />}
                                      {kinds.camera && <Video size={10} />}
                                      AO VIVO
                                    </span>
                                  )}
                                </button>
                                {staff && !name && (
                                  <button
                                    className="icon-button tiny"
                                    title="Remover sessão abandonada"
                                    aria-label="Remover sessão abandonada"
                                    onClick={() => onRemoveSession(id, memberId)}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
      {footer}
    </nav>
  );
}
