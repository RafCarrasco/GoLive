import { useEffect, useState } from 'react';
import { Check, FolderPlus, ImageOff, LoaderCircle, Pencil, Plus, Settings, Tag, Trash2, UserX, X } from 'lucide-react';
import { Avatar } from './Avatar';
import { NetworkSettings } from './NetworkSettings';
import {
  approveMember,
  assignRole,
  createRole,
  deleteRole,
  setMemberRole,
  updateRole,
  ROLE_COLORS,
  createCategory,
  deleteCategory,
  deleteChannel,
  editChannel,
  isSystemChannel,
  rejectRequest,
  renameCategory,
  revokeMember,
  setAvatar,
  roleLabel,
  isStaff,
  watchApprovedMembers,
  watchRequests,
  DEFAULT_CATEGORY_ID,
  type AccessRequest,
  type CommunityRole,
} from '../community';
import type { CommunityData } from '../hooks/useCommunity';
import { useDialogs } from '../ui/Modal';
import { useToast } from '../ui/Toast';

type Tab = 'members' | 'requests' | 'roles' | 'channels' | 'network';
const nameRule = (v: string) =>
  v.trim().length < 2 || v.trim().length > 32 ? 'Use de 2 a 32 caracteres.' : '';

export function AdminPanel({
  uid,
  data,
  onClose,
  onPermission,
  onCreateChannel,
}: {
  uid: string;
  data: CommunityData;
  onClose: () => void;
  onPermission: (target: { kind: 'category' | 'channel'; id: string }) => void;
  onCreateChannel: (categoryId: string) => void;
}) {
  const owner = data.roles[uid] === 'owner';
  const staff = isStaff(data.roles[uid] || 'member');
  const network = owner || Boolean(data.netAdmins[uid]);
  const [tab, setTab] = useState<Tab>(owner ? 'requests' : staff ? 'channels' : 'network');
  const [requests, setRequests] = useState<Record<string, AccessRequest>>({});
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const toast = useToast();
  const dialogs = useDialogs();

  useEffect(() => {
    if (!owner) return;
    const offs = [watchRequests(setRequests, toast.error), watchApprovedMembers(setApproved, toast.error)];
    return () => offs.forEach((off) => off());
  }, [owner, toast]);

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await action();
      toast.success(success);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy('');
    }
  };

  const pending = Object.entries(requests).filter(([id]) => !approved[id]);
  const memberIds = [
    ...new Set([...Object.keys(data.profiles), ...Object.keys(approved).filter((id) => approved[id])]),
  ];
  const tabs: Array<[Tab, string, number?]> = [
    ...(owner ? ([['requests', 'Solicitações', pending.length]] as Array<[Tab, string, number]>) : []),
    ...(staff ? ([['members', 'Membros']] as Array<[Tab, string]>) : []),
    ...(owner ? ([['roles', 'Cargos']] as Array<[Tab, string]>) : []),
    ...(staff ? ([['channels', 'Canais']] as Array<[Tab, string]>) : []),
    ...(network ? ([['network', 'Rede']] as Array<[Tab, string]>) : []),
  ];
  const roleEntries = Object.entries(data.roleDefs).sort((a, b) => a[1].createdAt - b[1].createdAt);
  const nextColor = ROLE_COLORS[roleEntries.length % ROLE_COLORS.length];
  const roleNameRule = (v: string) =>
    v.trim().length < 2 || v.trim().length > 24 ? 'Use de 2 a 24 caracteres.' : '';

  return (
    <section className="admin">
      <header className="admin-head">
        <div>
          <span className="kicker">ADMINISTRAÇÃO</span>
          <h1>Gerenciar comunidade</h1>
        </div>
        <button className="icon-button" aria-label="Fechar administração" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label, count]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'on' : ''}
            onClick={() => setTab(id)}
          >
            {label}
            {count ? <span className="badge">{count}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'requests' && (
        <div className="admin-list">
          {pending.length === 0 && <p className="empty muted">Nenhuma solicitação pendente.</p>}
          {pending.map(([id, request]) => (
            <div className="admin-row" key={id}>
              <span className="avatar">{request.email.slice(0, 1).toUpperCase()}</span>
              <div className="admin-row-text">
                <strong>{request.email}</strong>
                <small className="muted">
                  Pediu acesso em {new Date(request.createdAt).toLocaleString('pt-BR')}
                </small>
              </div>
              <button
                className="button ghost"
                disabled={busy !== ''}
                onClick={() => void run('reject:' + id, () => rejectRequest(id), 'Solicitação recusada')}
              >
                Recusar
              </button>
              <button
                className="button primary"
                disabled={busy !== ''}
                onClick={() => void run('approve:' + id, () => approveMember(id), 'Acesso liberado')}
              >
                {busy === 'approve:' + id ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
                Aprovar
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'members' && (
        <div className="admin-list">
          {memberIds.map((id) => {
            const profile = data.profiles[id];
            const role: CommunityRole = data.roles[id] || 'member';
            const name = profile?.displayName || requests[id]?.email || 'Ainda sem nickname';
            return (
              <div className="admin-row" key={id}>
                <Avatar photo={data.avatars[id]} name={name} />
                <div className="admin-row-text">
                  <strong>
                    {name}
                    {id === uid && <span className="muted"> (você)</span>}
                  </strong>
                  <small className="muted">{roleLabel[role]}</small>
                  {roleEntries.length > 0 && (owner || data.memberRoles[id]) && (
                    <div className="role-chips">
                      {roleEntries
                        .filter(([roleId]) => owner || data.memberRoles[id]?.[roleId])
                        .map(([roleId, def]) => {
                          const on = Boolean(data.memberRoles[id]?.[roleId]);
                          return (
                            <button
                              key={roleId}
                              className={'role-chip' + (on ? ' on' : '')}
                              style={{ '--role': def.color } as React.CSSProperties}
                              disabled={!owner || busy !== ''}
                              aria-pressed={on}
                              title={owner ? (on ? 'Tirar cargo' : 'Dar cargo') : undefined}
                              onClick={() =>
                                void run(
                                  'mrole:' + id,
                                  () => setMemberRole(id, roleId, !on),
                                  on ? `${def.name} removido de ${name}` : `${name} agora é ${def.name}`,
                                )
                              }
                            >
                              <span className="role-dot" />
                              {def.name}
                            </button>
                          );
                        })}
                    </div>
                  )}
                </div>
                {owner && id !== uid && (
                  <>
                    <select
                      aria-label={'Nível de ' + name}
                      title="Nível de administração"
                      value={role}
                      disabled={busy !== ''}
                      onChange={(e) =>
                        void run(
                          'role:' + id,
                          () => assignRole(id, e.target.value as CommunityRole),
                          'Cargo atualizado',
                        )
                      }
                    >
                      <option value="member">Membro</option>
                      <option value="admin">Administrador</option>
                    </select>
                    <button
                      className="icon-button danger"
                      title="Revogar acesso"
                      aria-label={'Revogar acesso de ' + name}
                      disabled={busy !== ''}
                      onClick={async () => {
                        const ok = await dialogs.confirm({
                          title: 'Revogar acesso?',
                          message: `${name} sai da comunidade imediatamente e precisará de uma nova aprovação.`,
                          confirmLabel: 'Revogar',
                          danger: true,
                        });
                        if (ok) await run('revoke:' + id, () => revokeMember(id), 'Acesso revogado');
                      }}
                    >
                      <UserX size={16} />
                    </button>
                  </>
                )}
                {owner && id !== uid && data.avatars[id] && (
                  <button
                    className="icon-button"
                    title="Remover foto"
                    aria-label={'Remover a foto de ' + name}
                    disabled={busy !== ''}
                    onClick={() => void run('photo:' + id, () => setAvatar(id, null), 'Foto removida')}
                  >
                    <ImageOff size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'network' && network && <NetworkSettings uid={uid} owner={owner} data={data} />}

      {tab === 'roles' && (
        <div className="admin-list">
          <p className="muted">
            Cargos funcionam como grupos de amigos. Marque-os na engrenagem de uma categoria ou canal: só quem
            tiver um dos cargos marcados vê aquela parte da comunidade. Administradores veem tudo.
          </p>
          <button
            className="button ghost align-start"
            onClick={async () => {
              const name = await dialogs.prompt({
                title: 'Novo cargo',
                label: 'Nome (ex.: Faculdade, Trampo)',
                validate: roleNameRule,
                confirmLabel: 'Criar',
              });
              if (name) await run('newrole', () => createRole(name, nextColor), 'Cargo criado');
            }}
          >
            <Tag size={16} /> Novo cargo
          </button>
          {roleEntries.length === 0 && <p className="empty muted">Nenhum cargo criado ainda.</p>}
          {roleEntries.map(([roleId, def]) => {
            const count = Object.values(data.memberRoles).filter((r) => r[roleId]).length;
            const nextIndex = (ROLE_COLORS.indexOf(def.color) + 1) % ROLE_COLORS.length;
            return (
              <div className="admin-row" key={roleId}>
                <button
                  className="role-swatch"
                  style={{ background: def.color }}
                  title="Trocar cor"
                  aria-label={'Trocar cor de ' + def.name}
                  disabled={busy !== ''}
                  onClick={() =>
                    void run(
                      'color',
                      () => updateRole(roleId, { color: ROLE_COLORS[nextIndex] }),
                      'Cor atualizada',
                    )
                  }
                />
                <div className="admin-row-text">
                  <strong style={{ color: def.color }}>{def.name}</strong>
                  <small className="muted">{count === 1 ? '1 pessoa' : `${count} pessoas`}</small>
                </div>
                <button
                  className="icon-button tiny"
                  title="Renomear"
                  aria-label={'Renomear ' + def.name}
                  onClick={async () => {
                    const name = await dialogs.prompt({
                      title: 'Renomear cargo',
                      label: 'Nome',
                      initial: def.name,
                      validate: roleNameRule,
                    });
                    if (name) await run('rrole', () => updateRole(roleId, { name }), 'Cargo atualizado');
                  }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-button tiny danger"
                  title="Excluir"
                  aria-label={'Excluir ' + def.name}
                  onClick={async () => {
                    const ok = await dialogs.confirm({
                      title: 'Excluir cargo?',
                      message: `${def.name} sai de todas as pessoas, categorias e canais. Áreas que só esse cargo via passam a ser visíveis para todos.`,
                      confirmLabel: 'Excluir',
                      danger: true,
                    });
                    if (ok)
                      await run(
                        'drole',
                        () => deleteRole(roleId, data.memberRoles, data.categoryRoles, data.channelRoles),
                        'Cargo excluído',
                      );
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'channels' && (
        <div className="admin-list">
          <button
            className="button ghost align-start"
            onClick={async () => {
              const name = await dialogs.prompt({
                title: 'Nova categoria',
                label: 'Nome',
                validate: nameRule,
                confirmLabel: 'Criar',
              });
              if (name) await run('cat', () => createCategory(uid, name), 'Categoria criada');
            }}
          >
            <FolderPlus size={16} /> Nova categoria
          </button>
          {Object.entries(data.categories)
            .sort((a, b) => a[1].order - b[1].order)
            .map(([categoryId, category]) => {
              const channels = Object.entries(data.channels).filter(
                ([, c]) => (c.categoryId || DEFAULT_CATEGORY_ID) === categoryId,
              );
              return (
                <div className="admin-group" key={categoryId}>
                  <div className="admin-group-head">
                    <strong>{category.name}</strong>
                    <span className="row-actions visible">
                      <button
                        className="icon-button tiny"
                        title="Novo canal"
                        aria-label="Novo canal"
                        onClick={() => onCreateChannel(categoryId)}
                      >
                        <Plus size={14} />
                      </button>
                      <button
                        className="icon-button tiny"
                        title="Permissões"
                        aria-label={'Permissões de ' + category.name}
                        onClick={() => onPermission({ kind: 'category', id: categoryId })}
                      >
                        <Settings size={14} />
                      </button>
                      {categoryId !== DEFAULT_CATEGORY_ID && (
                        <>
                          <button
                            className="icon-button tiny"
                            title="Renomear"
                            aria-label={'Renomear ' + category.name}
                            onClick={async () => {
                              const name = await dialogs.prompt({
                                title: 'Renomear categoria',
                                label: 'Nome',
                                initial: category.name,
                                validate: nameRule,
                              });
                              if (name)
                                await run(
                                  'rcat',
                                  () => renameCategory(categoryId, name),
                                  'Categoria atualizada',
                                );
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            className="icon-button tiny danger"
                            title={channels.length ? 'Mova ou exclua os canais antes' : 'Excluir'}
                            aria-label={'Excluir ' + category.name}
                            disabled={channels.length > 0}
                            onClick={async () => {
                              const ok = await dialogs.confirm({
                                title: 'Excluir categoria?',
                                message: category.name,
                                confirmLabel: 'Excluir',
                                danger: true,
                              });
                              if (ok)
                                await run('dcat', () => deleteCategory(categoryId), 'Categoria excluída');
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                  {channels.length === 0 && <p className="empty muted">Sem canais.</p>}
                  {channels.map(([id, channel]) => (
                    <div className="admin-row" key={id}>
                      <div className="admin-row-text">
                        <strong>{channel.name}</strong>
                        {!channel.enabled && <small className="muted">Desativado</small>}
                      </div>
                      {!isSystemChannel(id) && (
                        <select
                          aria-label={'Categoria de ' + channel.name}
                          value={channel.categoryId || DEFAULT_CATEGORY_ID}
                          onChange={(e) =>
                            void run(
                              'move',
                              () => editChannel(id, { categoryId: e.target.value }),
                              'Canal movido',
                            )
                          }
                        >
                          {Object.entries(data.categories).map(([cid, cat]) => (
                            <option key={cid} value={cid}>
                              {cat.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        className="icon-button tiny"
                        title="Permissões"
                        aria-label={'Permissões de ' + channel.name}
                        onClick={() => onPermission({ kind: 'channel', id })}
                      >
                        <Settings size={14} />
                      </button>
                      {!isSystemChannel(id) && (
                        <>
                          <button
                            className="icon-button tiny"
                            title="Renomear"
                            aria-label={'Renomear ' + channel.name}
                            onClick={async () => {
                              const name = await dialogs.prompt({
                                title: 'Renomear canal',
                                label: 'Nome',
                                initial: channel.name,
                                validate: nameRule,
                              });
                              if (name) await run('rch', () => editChannel(id, { name }), 'Canal atualizado');
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            className="icon-button tiny danger"
                            title="Excluir"
                            aria-label={'Excluir ' + channel.name}
                            onClick={async () => {
                              const ok = await dialogs.confirm({
                                title: 'Excluir canal?',
                                message: `${channel.name} some para todos. Quem estiver nele será desconectado.`,
                                confirmLabel: 'Excluir',
                                danger: true,
                              });
                              if (ok) await run('dch', () => deleteChannel(id), 'Canal excluído');
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
        </div>
      )}
    </section>
  );
}
