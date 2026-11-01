import {getAuth, onAuthStateChanged, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword} from 'firebase/auth';
export const observeUser=(fn: Parameters<typeof onAuthStateChanged>[1])=>onAuthStateChanged(getAuth(),fn);
export const signOutAccount=()=>signOut(getAuth());
export const createAccount=(email:string,secret:string)=>createUserWithEmailAndPassword(getAuth(),email.trim(),secret);
export const authenticate=(email:string,secret:string)=>signInWithEmailAndPassword(getAuth(),email.trim(),secret);
