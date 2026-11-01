import { get, onValue, push, ref, remove, set, update } from 'firebase/database';
import { db } from './firebase';
export type Category = { name: string; createdAt: number; createdBy: string; order: number };
export const DEFAULT_CATEGORY_ID = 'lives';
export const DEFAULT_CATEGORIES: Record<string, Category> = {
  lives: { name: 'Lives', createdAt: 0, createdBy: 'system', order: 0 },
};
export const watchCategories = (cb: (categories: Record<string, Category>) => void) =>
  onValue(ref(db, 'community/categories'), (s) => cb({ ...DEFAULT_CATEGORIES, ...(s.val() || {}) }));
export async function createCategory(uid: string, name: string) {
  const value = name.trim().slice(0, 32);
  if (value.length < 2) throw Error('Informe um nome de categoria');
  const id = push(ref(db, 'community/categories')).key;
  if (!id) throw Error('Falha ao criar categoria');
  await set(ref(db, 'community/categories/' + id), {
    name: value,
    createdAt: Date.now(),
    createdBy: uid,
    order: Date.now(),
  });
  return id;
}
export async function renameCategory(id: string, name: string) {
  if (id === DEFAULT_CATEGORY_ID) throw Error('Categoria padrão não pode ser renomeada');
  await update(ref(db, 'community/categories/' + id), { name: name.trim().slice(0, 32) });
}
export async function deleteCategory(id: string) {
  if (id === DEFAULT_CATEGORY_ID) throw Error('Categoria padrão não pode ser excluída');
  await remove(ref(db, 'community/categories/' + id));
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
  onValue(ref(db, 'community/channels'), (s) => cb({ ...SYSTEM_CHANNELS, ...(s.val() || {}) }));
export const watchProfiles = (cb: (profiles: Record<string, Profile>) => void) =>
  onValue(ref(db, 'community/profiles'), (s) => cb(s.val() || {}));
export const watchRoles = (cb: (roles: Record<string, CommunityRole>) => void) =>
  onValue(ref(db, 'community/roles'), (s) => cb(s.val() || {}));
export async function saveProfile(uid: string, name: string) {
  const displayName = name.trim().slice(0, 32);
  if (displayName.length < 2) throw Error('Informe um nome de 2 a 32 caracteres');
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
  await set(ref(db, 'community/channels/' + id), {
    name: normalized,
    categoryId,
    description: description.trim().slice(0, 160),
    createdBy: uid,
    createdAt: Date.now(),
    visibility: 'public',
    enabled: true,
  });
  return id;
}
export async function editChannel(
  id: string,
  fields: Partial<Pick<Channel, 'name' | 'description' | 'enabled' | 'categoryId'>>,
) {
  await update(ref(db, 'community/channels/' + id), fields);
}
export async function deleteChannel(id: string) {
  if (id === 'geral' || id === 'competitivo') throw Error('Canais padrão não podem ser excluídos');
  await remove(ref(db, 'community/channels/' + id));
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
