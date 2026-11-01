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
  type AccessLevel,
  type Category,
  type Channel,
  type CommunityRole,
  type Profile,
} from '../community';
import { parseBroadcasts, type Broadcasts } from '../live/room';

export type CommunityData = {
  loaded: boolean;
  channels: Record<string, Channel>;
  categories: Record<string, Category>;
  channelAccess: Record<string, AccessLevel>;
  categoryAccess: Record<string, AccessLevel>;
  profiles: Record<string, Profile>;
  roles: Record<string, CommunityRole>;
};

export function useCommunity(): CommunityData {
  const [channels, setChannels] = useState<Record<string, Channel>>(SYSTEM_CHANNELS);
  const [categories, setCategories] = useState<Record<string, Category>>(DEFAULT_CATEGORIES);
  const [channelAccess, setChannelAccess] = useState<Record<string, AccessLevel>>({});
  const [categoryAccess, setCategoryAccess] = useState<Record<string, AccessLevel>>({});
  const [profiles, setProfiles] = useState<Record<string, Profile> | null>(null);
  const [roles, setRoles] = useState<Record<string, CommunityRole>>({});
  useEffect(() => {
    const unsubs = [
      watchChannels(setChannels),
      watchCategories(setCategories),
      watchChannelAccess(setChannelAccess),
      watchCategoryAccess(setCategoryAccess),
      watchProfiles(setProfiles),
      watchRoles(setRoles),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);
  return {
    loaded: profiles !== null,
    channels,
    categories,
    channelAccess,
    categoryAccess,
    profiles: profiles || {},
    roles,
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
