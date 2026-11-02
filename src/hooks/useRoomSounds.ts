import { useEffect, useRef } from 'react';
import { liveKey, STREAM_KINDS, type LiveSnapshot } from '../live/room';
import { playSound } from '../lib/sounds';

// Som quando alguém entra ou sai do canal em que você está e quando uma live começa.
// Logo depois de entrar, a lista de quem já estava chega aos poucos: esse início não toca nada.
const SETTLE_MS = 2000;

export function useRoomSounds(snapshot: LiveSnapshot) {
  const previous = useRef<{ room: string; members: Set<string>; lives: Set<string>; since: number } | null>(
    null,
  );
  useEffect(() => {
    const before = previous.current;
    if (!snapshot.joined) {
      if (before) playSound('leave');
      previous.current = null;
      return;
    }
    const members = new Set(snapshot.members);
    const lives = new Set(
      Object.entries(snapshot.broadcasts).flatMap(([id, kinds]) =>
        STREAM_KINDS.filter((kind) => kinds[kind]).map((kind) => liveKey(id, kind)),
      ),
    );
    if (!before || before.room !== snapshot.room) {
      previous.current = { room: snapshot.room, members, lives, since: Date.now() };
      playSound('join');
      return;
    }
    previous.current = { ...before, members, lives };
    if (Date.now() - before.since < SETTLE_MS) return;
    if ([...lives].some((key) => !before.lives.has(key))) playSound('live');
    else if ([...members].some((id) => !before.members.has(id))) playSound('join');
    else if ([...before.members].some((id) => !members.has(id))) playSound('leave');
  }, [snapshot.joined, snapshot.room, snapshot.members, snapshot.broadcasts]);
}
