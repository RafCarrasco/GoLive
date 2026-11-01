import { useEffect, useState } from 'react';
import { completeGoogleRedirect, observeUser, signInDevUser } from '../session';
import { requestAccess, watchApproval } from '../community';
import { errorMessage } from '../lib/errors';

export type AuthState = {
  ready: boolean;
  uid: string;
  email: string;
  // null enquanto a aprovação ainda está sendo consultada.
  approved: boolean | null;
  error: string;
};

export function useAuth(): AuthState {
  const [user, setUser] = useState<{ uid: string; email: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  // A aprovação fica associada ao uid; trocar de conta nunca reaproveita o estado anterior.
  const [approval, setApproval] = useState<{ uid: string; value: boolean } | null>(null);

  useEffect(() => {
    void completeGoogleRedirect().catch((e) => setError(errorMessage(e)));
    void signInDevUser().catch((e) => setError(errorMessage(e)));
    return observeUser((u) => {
      setUser(u ? { uid: u.uid, email: u.email || '' } : null);
      setReady(true);
    });
  }, []);

  const uid = user?.uid || '';
  const email = user?.email || '';
  useEffect(() => {
    if (!uid) return;
    let requested = false;
    return watchApproval(
      uid,
      (value) => {
        setApproval({ uid, value });
        // Só registra a solicitação quando ainda não aprovado, para não recriá-la a cada login.
        if (!value && !requested && email) {
          requested = true;
          void requestAccess(uid, email).catch(() => {});
        }
      },
      (e) => setError(errorMessage(e)),
    );
  }, [uid, email]);

  return {
    ready,
    uid,
    email,
    approved: approval && approval.uid === uid ? approval.value : null,
    error,
  };
}
