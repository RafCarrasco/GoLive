import {getAuth,onAuthStateChanged,signOut,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult} from 'firebase/auth';
export const observeUser=(fn:Parameters<typeof onAuthStateChanged>[1])=>onAuthStateChanged(getAuth(),fn);
export const signOutAccount=()=>signOut(getAuth());
const provider=new GoogleAuthProvider();
provider.setCustomParameters({prompt:'select_account'});
export const signInGoogle=async()=>{if(/Electron/i.test(navigator.userAgent)){return signInWithRedirect(getAuth(),provider)}return signInWithPopup(getAuth(),provider)};
export const completeGoogleRedirect=()=>getRedirectResult(getAuth());
