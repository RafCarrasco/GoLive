import { get, onValue, push, ref, remove, set, update } from 'firebase/database';
import { db } from './firebase';
export type Category = { name: string; createdAt: number; createdBy: string; order: number };
export const DEFAULT_CATEGORY_ID = 'lives';
export const DEFAULT_CATEGORIES: Record<string, Category> = {
  lives: { name: 'Lives', createdAt: 0, createdBy: 'system', order: 0 },
};
// Categorias e canais são lidos um a um a partir de um índice só com ids: os que a pessoa não pode
// ver são recusados pelo servidor e simplesmente não aparecem.
function watchIndexed<T>(
  index: string,
  items: string,
  base: Record<string, T>,
  cb: (v: Record<string, T>) => void,
) {
  const loaded: Record<string, T> = {};
  const subs = new Map<string, () => void>();
  const emit = () => cb({ ...base, ...loaded });
  const offIndex = onValue(
    ref(db, index),
    (snap) => {
      const ids = Object.keys(snap.val() || {});
      for (const [id, off] of subs)
        if (!ids.includes(id)) {
          off();
          subs.delete(id);
          delete loaded[id];
        }
      for (const id of ids)
        if (!subs.has(id))
          subs.set(
            id,
            onValue(
              ref(db, `${items}/${id}`),
              (item) => {
                if (item.exists()) loaded[id] = item.val();
                else delete loaded[id];
                emit();
              },
              () => {
                delete loaded[id];
                emit();
              },
            ),
          );
      emit();
    },
    () => emit(),
  );
  return () => {
    offIndex();
    subs.forEach((off) => off());
  };
}

export const watchCategories = (cb: (categories: Record<string, Category>) => void) =>
  watchIndexed('community/categoryIds', 'community/categories', DEFAULT_CATEGORIES, cb);
export async function createCategory(uid: string, name: string) {
  const value = name.trim().slice(0, 32);
  if (value.length < 2) throw Error('Informe um nome de categoria');
  const id = push(ref(db, 'community/categories')).key;
  if (!id) throw Error('Falha ao criar categoria');
  const order = Date.now();
  await update(ref(db, 'community'), {
    [`categories/${id}`]: { name: value, createdAt: Date.now(), createdBy: uid, order },
    [`categoryIds/${id}`]: order,
  });
  return id;
}
export async function renameCategory(id: string, name: string) {
  if (id === DEFAULT_CATEGORY_ID) throw Error('Categoria padrão não pode ser renomeada');
  await update(ref(db, 'community/categories/' + id), { name: name.trim().slice(0, 32) });
}
export async function deleteCategory(id: string) {
  if (id === DEFAULT_CATEGORY_ID) throw Error('Categoria padrão não pode ser excluída');
  await update(ref(db, 'community'), { [`categories/${id}`]: null, [`categoryIds/${id}`]: null });
  await remove(ref(db, 'community/categoryAccess/' + id)).catch(() => {});
  await remove(ref(db, 'community/categoryRoles/' + id)).catch(() => {});
}
export type Channel = {
  categoryId?: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: number;
  visibility: 'public' | 'restricted';
  enabled: boolean;
};
export type Profile = { displayName: string; createdAt: number; updatedAt: number };
export type CommunityRole = 'owner' | 'admin' | 'member';
export const SYSTEM_CHANNELS: Record<string, Channel> = {
  geral: {
    name: 'Geral',
    description: 'Jogos, lives e conversa',
    createdBy: 'system',
    createdAt: 0,
    visibility: 'public',
    enabled: true,
  },
  competitivo: {
    name: 'Competitivo',
    description: 'Partidas e comunicação de equipe',
    createdBy: 'system',
    createdAt: 0,
    visibility: 'public',
    enabled: true,
  },
};
export const watchChannels = (cb: (channels: Record<string, Channel>) => void) =>
  watchIndexed('community/channelIds', 'community/channels', SYSTEM_CHANNELS, cb);
export const watchProfiles = (cb: (profiles: Record<string, Profile>) => void) =>
  onValue(ref(db, 'community/profiles'), (s) => cb(s.val() || {}));
export const watchRoles = (cb: (roles: Record<string, CommunityRole>) => void) =>
  onValue(ref(db, 'community/roles'), (s) => cb(s.val() || {}));
export const NICKNAME_MIN = 3;
export const NICKNAME_MAX = 24;
export function nicknameError(name: string) {
  const length = name.trim().length;
  return length < NICKNAME_MIN || length > NICKNAME_MAX
    ? `Use de ${NICKNAME_MIN} a ${NICKNAME_MAX} caracteres.`
    : '';
}
export async function saveProfile(uid: string, name: string) {
  const displayName = name.trim();
  const invalid = nicknameError(displayName);
  if (invalid) throw Error(invalid);
  const p = ref(db, 'community/profiles/' + uid);
  const old = await get(p);
  await set(p, { displayName, createdAt: old.val()?.createdAt || Date.now(), updatedAt: Date.now() });
}
export async function createChannel(
  uid: string,
  name: string,
  description: string,
  categoryId = DEFAULT_CATEGORY_ID,
) {
  const normalized = name.trim().slice(0, 32);
  if (normalized.length < 2) throw Error('Nome do canal muito curto');
  const id = push(ref(db, 'community/channels')).key;
  if (!id) throw Error('Não foi possível gerar o canal');
  await update(ref(db, 'community'), {
    [`channels/${id}`]: {
      name: normalized,
      categoryId,
      description: description.trim().slice(0, 160),
      createdBy: uid,
      createdAt: Date.now(),
      visibility: 'public',
      enabled: true,
    },
    [`channelIds/${id}`]: true,
  });
  return id;
}
export async function editChannel(
  id: string,
  fields: Partial<Pick<Channel, 'name' | 'description' | 'enabled' | 'categoryId'>>,
) {
  await update(ref(db, 'community/channels/' + id), fields);
}
export const isSystemChannel = (id: string) => id in SYSTEM_CHANNELS;
export async function deleteChannel(id: string) {
  if (isSystemChannel(id)) throw Error('Canais padrão não podem ser excluídos');
  await update(ref(db, 'community'), { [`channels/${id}`]: null, [`channelIds/${id}`]: null });
  await remove(ref(db, 'community/channelAccess/' + id)).catch(() => {});
  await remove(ref(db, 'community/channelRoles/' + id)).catch(() => {});
}
export async function assignRole(uid: string, role: CommunityRole) {
  await set(ref(db, 'community/roles/' + uid), role);
}

export type AccessLevel = 'member' | 'admin' | 'owner';
export const accessLabel: Record<AccessLevel, string> = {
  member: 'Todos os membros',
  admin: 'Administradores e proprietário',
  owner: 'Somente proprietário',
};
export const watchCategoryAccess = (cb: (v: Record<string, AccessLevel>) => void) =>
  onValue(ref(db, 'community/categoryAccess'), (s) => cb(s.val() || {}));
export const watchChannelAccess = (cb: (v: Record<string, AccessLevel>) => void) =>
  onValue(ref(db, 'community/channelAccess'), (s) => cb(s.val() || {}));
export const setCategoryAccess = (id: string, level: AccessLevel) =>
  set(ref(db, 'community/categoryAccess/' + id), level);
export const setChannelAccess = (id: string, level: AccessLevel) =>
  set(ref(db, 'community/channelAccess/' + id), level);
export function canAccess(level: AccessLevel, role: CommunityRole) {
  return level === 'member' || role === 'owner' || (level === 'admin' && role === 'admin');
}
export const isStaff = (role: CommunityRole | undefined) => role === 'owner' || role === 'admin';

// Cargos personalizados (grupos de amigos), além do nível owner/admin/member.
export type RoleDef = { name: string; color: string; createdAt: number };
export const ROLE_SLOTS = 5;
export const ROLE_COLORS = [
  '#7c6cff',
  '#3ecf8e',
  '#f0475a',
  '#f5b14c',
  '#4cc3f5',
  '#ff7ac6',
  '#a3e635',
  '#94a3b8',
];
export type RoleLists = Record<string, string[]>;
const asList = (v: unknown) => Object.values((v as Record<string, string>) || {}).filter(Boolean);
export const watchRoleDefs = (cb: (v: Record<string, RoleDef>) => void) =>
  onValue(ref(db, 'community/roleDefs'), (s) => cb(s.val() || {}));
export const watchMemberRoles = (cb: (v: Record<string, Record<string, true>>) => void) =>
  onValue(ref(db, 'community/memberRoles'), (s) => cb(s.val() || {}));
const watchRoleLists = (path: string) => (cb: (v: RoleLists) => void) =>
  onValue(ref(db, path), (s) =>
    cb(Object.fromEntries(Object.entries(s.val() || {}).map(([id, v]) => [id, asList(v)]))),
  );
export const watchCategoryRoles = watchRoleLists('community/categoryRoles');
export const watchChannelRoles = watchRoleLists('community/channelRoles');

export async function createRole(name: string, color: string) {
  const id = push(ref(db, 'community/roleDefs')).key!;
  await set(ref(db, 'community/roleDefs/' + id), { name: name.trim(), color, createdAt: Date.now() });
  return id;
}
export const updateRole = (id: string, fields: Partial<Pick<RoleDef, 'name' | 'color'>>) =>
  update(ref(db, 'community/roleDefs/' + id), fields);
export const setMemberRole = (uid: string, roleId: string, on: boolean) =>
  set(ref(db, `community/memberRoles/${uid}/${roleId}`), on ? true : null);
export const setCategoryRoles = (id: string, roleIds: string[]) =>
  set(ref(db, 'community/categoryRoles/' + id), roleIds.length ? roleIds.slice(0, ROLE_SLOTS) : null);
export const setChannelRoles = (id: string, roleIds: string[]) =>
  set(ref(db, 'community/channelRoles/' + id), roleIds.length ? roleIds.slice(0, ROLE_SLOTS) : null);
// Excluir um cargo também o tira das pessoas e das categorias/canais, numa única escrita.
export async function deleteRole(
  id: string,
  memberRoles: Record<string, Record<string, true>>,
  categoryRoles: RoleLists,
  channelRoles: RoleLists,
) {
  const changes: Record<string, unknown> = { [`roleDefs/${id}`]: null };
  for (const [uid, roles] of Object.entries(memberRoles))
    if (roles[id]) changes[`memberRoles/${uid}/${id}`] = null;
  const lists: Array<[string, RoleLists]> = [
    ['categoryRoles', categoryRoles],
    ['channelRoles', channelRoles],
  ];
  for (const [key, byTarget] of lists)
    for (const [target, list] of Object.entries(byTarget))
      if (list.includes(id)) {
        const rest = list.filter((r) => r !== id);
        changes[`${key}/${target}`] = rest.length ? rest : null;
      }
  await update(ref(db, 'community'), changes);
}

export type AccessData = {
  roles: Record<string, CommunityRole>;
  memberRoles: Record<string, Record<string, true>>;
  channels: Record<string, Channel>;
  channelAccess: Record<string, AccessLevel>;
  categoryAccess: Record<string, AccessLevel>;
  channelRoles: RoleLists;
  categoryRoles: RoleLists;
};
function rolesOk(required: string[] | undefined, uid: string, data: AccessData) {
  if (!required?.length || isStaff(data.roles[uid])) return true;
  return required.some((roleId) => data.memberRoles[uid]?.[roleId]);
}

// Espelham as regras do banco (nível + cargos, canal + categoria). São só para a interface;
// quem garante o acesso são as regras do RTDB.
export function categoryAllowed(categoryId: string, uid: string, data: AccessData) {
  return (
    canAccess(data.categoryAccess[categoryId] || 'member', data.roles[uid] || 'member') &&
    rolesOk(data.categoryRoles[categoryId], uid, data)
  );
}
export function channelAllowed(channelId: string, uid: string, data: AccessData) {
  const channel = data.channels[channelId];
  if (!channel?.enabled) return false;
  return (
    canAccess(data.channelAccess[channelId] || 'member', data.roles[uid] || 'member') &&
    rolesOk(data.channelRoles[channelId], uid, data) &&
    categoryAllowed(channel.categoryId || DEFAULT_CATEGORY_ID, uid, data)
  );
}

export type AccessRequest = { email: string; createdAt: number };
export const watchApproval = (uid: string, cb: (approved: boolean) => void, onError: (e: Error) => void) =>
  onValue(ref(db, 'community/approved/' + uid), (s) => cb(s.val() === true), onError);
export const requestAccess = (uid: string, email: string) =>
  set(ref(db, 'community/requests/' + uid), { email, createdAt: Date.now() });
export const watchRequests = (cb: (v: Record<string, AccessRequest>) => void, onError: (e: Error) => void) =>
  onValue(ref(db, 'community/requests'), (s) => cb(s.val() || {}), onError);
export const watchApprovedMembers = (cb: (v: Record<string, boolean>) => void, onError: (e: Error) => void) =>
  onValue(ref(db, 'community/approved'), (s) => cb(s.val() || {}), onError);
export async function approveMember(uid: string) {
  await set(ref(db, 'community/approved/' + uid), true);
  await remove(ref(db, 'community/requests/' + uid)).catch(() => {});
}
export const rejectRequest = (uid: string) => remove(ref(db, 'community/requests/' + uid));
export const revokeMember = (uid: string) => remove(ref(db, 'community/approved/' + uid));
// Limpa uma sessão abandonada (ex.: navegador fechado antes do onDisconnect ser registrado).
export async function removeRoomSession(roomId: string, uid: string) {
  await remove(ref(db, `rooms/${roomId}/streams/${uid}`));
  await remove(ref(db, `rooms/${roomId}/members/${uid}`));
}

export const roleLabel: Record<CommunityRole, string> = {
  owner: 'Proprietário',
  admin: 'Administrador',
  member: 'Membro',
};
