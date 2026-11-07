import { getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  inMemoryPersistence,
  setPersistence,
  getRedirectResult,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { auth, firebaseConfig, useEmulators } from './firebase';
import { desktop, desktopSignIn } from './desktop';

export const observeUser = (fn: (user: User | null) => void) => onAuthStateChanged(auth, fn);
export const signOutAccount = () => signOut(auth);

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

// O Google não permite login dentro do app: ele abre o navegador do sistema, que devolve a
// credencial ao app (veja DesktopLogin).
export const signInGoogle = async () => {
  if (desktop) {
    const { idToken, accessToken } = await desktopSignIn();
    return signInWithCredential(auth, GoogleAuthProvider.credential(idToken || null, accessToken || null));
  }
  if (/Electron/i.test(navigator.userAgent)) return signInWithRedirect(auth, provider);
  try {
    return await signInWithPopup(auth, provider);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment')
      return signInWithRedirect(auth, provider);
    throw e;
  }
};
export const completeGoogleRedirect = () => getRedirectResult(auth);

// Página /desktop-login: faz o login do Google numa instância separada e sem persistência (o
// navegador não fica logado por causa disso) e devolve só a credencial do Google para o app.
export async function googleCredentialForDesktop() {
  if (useEmulators) {
    const name = new URLSearchParams(location.search).get('devUser') || 'app';
    const idToken = JSON.stringify({ sub: 'dev-' + name, email: `${name}@nimbo.test`, email_verified: true });
    return { idToken, accessToken: '' };
  }
  const app = getApps().find((a) => a.name === 'desktop-login') || initializeApp(firebaseConfig, 'desktop-login');
  const loginAuth = getAuth(app);
  await setPersistence(loginAuth, inMemoryPersistence);
  const result = await signInWithPopup(loginAuth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  await signOut(loginAuth);
  if (!credential?.idToken) throw new Error('O Google não devolveu a credencial. Tente de novo.');
  return { idToken: credential.idToken, accessToken: credential.accessToken || '' };
}

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
