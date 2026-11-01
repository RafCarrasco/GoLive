import { useEffect, useState } from 'react';
import { onValue, ref } from 'firebase/database';
import { db } from '../firebase';
import {
  DEFAULT_CATEGORIES,
  SYSTEM_CHANNELS,
  watchCategories,
  watchCategoryAccess,
  watchChannelAccess,
  watchChannels,
  watchProfiles,
  watchRoles,
  watchCategoryRoles,
  watchChannelRoles,
  watchMemberRoles,
  watchRoleDefs,
  type AccessData,
  type AccessLevel,
  type Category,
  type Channel,
  type CommunityRole,
  type Profile,
  type RoleDef,
  type RoleLists,
} from '../community';
import { parseBroadcasts, type Broadcasts } from '../live/room';

export type CommunityData = AccessData & {
  loaded: boolean;
  categories: Record<string, Category>;
  profiles: Record<string, Profile>;
  roleDefs: Record<string, RoleDef>;
};

export function useCommunity(uid: string): CommunityData {
  const [channels, setChannels] = useState<Record<string, Channel>>(SYSTEM_CHANNELS);
  const [categories, setCategories] = useState<Record<string, Category>>(DEFAULT_CATEGORIES);
  const [channelAccess, setChannelAccess] = useState<Record<string, AccessLevel>>({});
  const [categoryAccess, setCategoryAccess] = useState<Record<string, AccessLevel>>({});
  const [profiles, setProfiles] = useState<Record<string, Profile> | null>(null);
  const [roles, setRoles] = useState<Record<string, CommunityRole>>({});
  const [roleDefs, setRoleDefs] = useState<Record<string, RoleDef>>({});
  const [memberRoles, setMemberRoles] = useState<Record<string, Record<string, true>>>({});
  const [categoryRoles, setCategoryRoles] = useState<RoleLists>({});
  const [channelRoles, setChannelRoles] = useState<RoleLists>({});
  useEffect(() => {
    const unsubs = [
      watchChannelAccess(setChannelAccess),
      watchCategoryAccess(setCategoryAccess),
      watchProfiles(setProfiles),
      watchRoles(setRoles),
      watchRoleDefs(setRoleDefs),
      watchMemberRoles(setMemberRoles),
      watchCategoryRoles(setCategoryRoles),
      watchChannelRoles(setChannelRoles),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // O servidor só entrega as categorias e canais que a pessoa pode ver, e um pedido recusado não é
  // refeito sozinho. Quando cargos ou permissões mudam, as leituras são refeitas para refletir o
  // novo acesso na hora (ganhar um cargo mostra a categoria sem recarregar a página).
  const permissions = JSON.stringify([
    roles[uid],
    memberRoles[uid],
    channelAccess,
    categoryAccess,
    channelRoles,
    categoryRoles,
  ]);
  useEffect(() => {
    const unsubs = [watchChannels(setChannels), watchCategories(setCategories)];
    return () => unsubs.forEach((u) => u());
  }, [permissions]);

  return {
    loaded: profiles !== null,
    channels,
    categories,
    channelAccess,
    categoryAccess,
    profiles: profiles || {},
    roles,
    roleDefs,
    memberRoles,
    categoryRoles,
    channelRoles,
  };
}

export type RoomPresence = { members: string[]; streams: Broadcasts };

// Presença de cada canal visível na barra lateral. Escuta apenas members e streams (nunca a sala
// inteira, que incluiria a sinalização). Canais sem permissão são recusados pelas regras e ficam vazios.
export function useRoomsPresence(channelIds: string[]) {
  const [presence, setPresence] = useState<Record<string, RoomPresence>>({});
  const key = [...channelIds].sort().join('|');
  useEffect(() => {
    const ids = key ? key.split('|') : [];
    const patch = (id: string, field: keyof RoomPresence, value: unknown) =>
      setPresence((prev) => ({
        ...prev,
        [id]: { ...(prev[id] ?? { members: [], streams: {} }), [field]: value },
      }));
    const unsubs = ids.flatMap((id) => [
      onValue(
        ref(db, `rooms/${id}/members`),
        (s) => patch(id, 'members', Object.keys(s.val() || {})),
        () => patch(id, 'members', []),
      ),
      onValue(
        ref(db, `rooms/${id}/streams`),
        (s) => patch(id, 'streams', parseBroadcasts(s.val())),
        () => patch(id, 'streams', {}),
      ),
    ]);
    return () => unsubs.forEach((u) => u());
  }, [key]);
  return presence;
}
