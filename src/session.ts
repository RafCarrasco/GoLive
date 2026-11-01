import {getAuth, onAuthStateChanged, signOut} from 'firebase/auth';
export const observeUser=(fn: Parameters<typeof onAuthStateChanged>[1])=>onAuthStateChanged(getAuth(),fn);
export const signOutAccount=()=>signOut(getAuth());
