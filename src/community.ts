import {get, onValue, push, ref, remove, set, update} from 'firebase/database';
import {db} from './firebase';
export type Channel = {name:string;description:string;createdBy:string;createdAt:number;visibility:'public'|'restricted';enabled:boolean};
export type Profile = {displayName:string;createdAt:number;updatedAt:number};
export type CommunityRole = 'owner'|'admin'|'member';
export const SYSTEM_CHANNELS:Record<string,Channel>={
 geral:{name:'Geral',description:'Jogos, lives e conversa',createdBy:'system',createdAt:0,visibility:'public',enabled:true},
 competitivo:{name:'Competitivo',description:'Partidas e comunicação de equipe',createdBy:'system',createdAt:0,visibility:'public',enabled:true}
};
export const watchChannels=(cb:(channels:Record<string,Channel>)=>void)=>onValue(ref(db,'community/channels'),s=>cb({...SYSTEM_CHANNELS,...(s.val()||{})}));
export const watchProfiles=(cb:(profiles:Record<string,Profile>)=>void)=>onValue(ref(db,'community/profiles'),s=>cb(s.val()||{}));
export const watchRoles=(cb:(roles:Record<string,CommunityRole>)=>void)=>onValue(ref(db,'community/roles'),s=>cb(s.val()||{}));
export async function saveProfile(uid:string,name:string){const displayName=name.trim().slice(0,32);if(displayName.length<2)throw Error('Informe um nome de 2 a 32 caracteres');const p=ref(db,'community/profiles/'+uid);const old=await get(p);await set(p,{displayName,createdAt:old.val()?.createdAt||Date.now(),updatedAt:Date.now()})}
export async function createChannel(uid:string,name:string,description:string){const normalized=name.trim().slice(0,32);if(normalized.length<2)throw Error('Nome do canal muito curto');const id=push(ref(db,'community/channels')).key;if(!id)throw Error('Não foi possível gerar o canal');await set(ref(db,'community/channels/'+id),{name:normalized,description:description.trim().slice(0,160),createdBy:uid,createdAt:Date.now(),visibility:'public',enabled:true});return id}
export async function editChannel(id:string,fields:Partial<Pick<Channel,'name'|'description'|'enabled'>>){await update(ref(db,'community/channels/'+id),fields)}
export async function deleteChannel(id:string){if(id==='geral'||id==='competitivo')throw Error('Canais padrão não podem ser excluídos');await remove(ref(db,'community/channels/'+id))}
export async function assignRole(uid:string,role:CommunityRole){await set(ref(db,'community/roles/'+uid),role)}
