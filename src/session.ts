import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { auth, useEmulators } from './firebase';

export const observeUser = (fn: (user: User | null) => void) => onAuthStateChanged(auth, fn);
export const signOutAccount = () => signOut(auth);

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

export const signInGoogle = async () => {
  if (/Electron/i.test(navigator.userAgent)) return signInWithRedirect(auth, provider);
  return signInWithPopup(auth, provider);
};
export const completeGoogleRedirect = () => getRedirectResult(auth);

// Somente com emuladores: `?devUser=nome` entra com uma conta Google fictícia do Auth Emulator.
export async function signInDevUser() {
  if (!useEmulators) return false;
  const name = new URLSearchParams(location.search).get('devUser');
  if (!name) return false;
  const credential = GoogleAuthProvider.credential(
    JSON.stringify({ sub: 'dev-' + name, email: `${name}@nimbo.test`, email_verified: true }),
  );
  await signInWithCredential(auth, credential);
  return true;
}
