import { z } from 'zod';
import { MemoryError } from '../memory/model.js';

const text=z.string().min(1).max(200).refine(v=>!/[\u0000-\u001f\u007f]/.test(v));
export const principalSchema=z.strictObject({issuer:text,subject:text});
export type Principal=z.infer<typeof principalSchema>;
export const accessScopeSchema=z.strictObject({project_id:z.uuid(),repository:text.max(100),environment:text.max(100)});
export type AccessScope=z.infer<typeof accessScopeSchema>;
export const roleSchema=z.enum(['owner','editor','viewer']);
export type AccessRole=z.infer<typeof roleSchema>;
export type AccessAction='read'|'write';
export function permits(role:AccessRole,action:AccessAction){return action==='read'||role==='owner'||role==='editor';}
export class AccessError extends MemoryError {
 constructor(public readonly status:401|403|503,code='access_denied') {super(code,status===401?'Authentication required.':status===403?'Project access denied.':'Authentication or access policy unavailable.');}
}
export interface CredentialLease {policy_id:string;version:number;expires_at:number}
export interface Authentication {principal:Principal;expires_at:number;assertFresh():void|Promise<void>;credential?:CredentialLease}
export interface Authenticator {authenticate(request:Request):Promise<Authentication>}
