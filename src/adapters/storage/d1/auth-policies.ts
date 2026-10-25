import { z } from 'zod';
import { AccessError } from '../../../core/access/model.js';
import { MemoryError } from '../../../core/memory/model.js';
import { parseAccessPolicy,type AccessPolicy } from '../../auth/cloudflare-access.js';
import type { D1Binding } from './binding.js';
import { canonical,hashText,rows } from './query.js';

export const policyIdSchema=z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const keyIdentity=z.strictObject({kid:z.string().min(1).max(200),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)});
const entrySchema=z.strictObject({policy:z.unknown(),history:z.array(keyIdentity).min(1).max(128),revoked:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(128)});
const rowSchema=z.strictObject({version:z.int().positive(),state:z.enum(['active','revoked']),valid_until:z.int().positive(),entry_json:z.string().max(65536)});
export async function keyFingerprint(key:AccessPolicy['keys'][number]){return hashText(canonical({e:key.e,kty:key.kty,n:key.n}));}
/** Trusted host input only; no HTTP provisioning, private keys or remote JWKS fetch. */
export class D1AuthPolicies {
 constructor(private readonly db:D1Binding,private readonly now:()=>number=()=>Date.now()){}
 async read(id:string){
  policyIdSchema.parse(id);
  try{
   const [r]=await rows(this.db,'SELECT version,state,valid_until,entry_json FROM cloud_auth_versions WHERE policy_id=? ORDER BY version DESC LIMIT 1',[id],1);
   if(!r)return null;
   const row=rowSchema.parse(r),entry=entrySchema.parse(JSON.parse(row.entry_json)),policy=parseAccessPolicy(entry.policy);
   if(row.valid_until!==policy.valid_until)throw new Error('Invalid policy');
   const seen=new Set<string>();
   for(const key of policy.keys){const fingerprint=await keyFingerprint(key);if(seen.has(fingerprint)||!entry.history.some(k=>k.kid===key.kid&&k.fingerprint===fingerprint)||(row.state==='active'&&entry.revoked.includes(fingerprint)))throw new Error('Invalid key history');seen.add(fingerprint);}
   return {version:row.version,state:row.state,policy,history:entry.history,revoked:entry.revoked};
  }catch{throw new AccessError(503,'authentication_unavailable');}
 }
 private live(policy:AccessPolicy){const now=Math.floor(this.now()/1000);if(policy.fetched_at>now||policy.valid_until<=now)throw new AccessError(503,'authentication_unavailable');}
 async current(id:string){const entry=await this.read(id);if(!entry||entry.state!=='active')throw new AccessError(503,'authentication_unavailable');this.live(entry.policy);return entry;}
 /** expectedVersion=0 is a host bootstrap, never a first-visitor claim. */
 async publish(id:string,value:AccessPolicy,expectedVersion:number){
  policyIdSchema.parse(id);z.int().nonnegative().parse(expectedVersion);
  const policy=parseAccessPolicy(value);this.live(policy);const previous=await this.read(id);
  if((previous?.version??0)!==expectedVersion)throw new MemoryError('authentication_conflict','Policy version changed.');
  if(previous&&(policy.issuer!==previous.policy.issuer||policy.audience!==previous.policy.audience||policy.max_token_age_seconds!==previous.policy.max_token_age_seconds||policy.fetched_at<previous.policy.fetched_at))throw new MemoryError('authentication_conflict','Policy identity or time cannot move backwards.');
  const history=previous?[...previous.history]:[],revoked=new Set(previous?.revoked??[]),active=new Set<string>();
  for(const key of policy.keys){
   const fingerprint=await keyFingerprint(key);
   if(active.has(fingerprint)||revoked.has(fingerprint)||history.some(k=>(k.kid===key.kid&&k.fingerprint!==fingerprint)||(k.fingerprint===fingerprint&&k.kid!==key.kid)))throw new MemoryError('authentication_conflict','Key identity is retired or differs.');
   active.add(fingerprint);if(!history.some(k=>k.kid===key.kid))history.push({kid:key.kid,fingerprint});
  }
  if(previous)for(const key of previous.policy.keys){const fingerprint=await keyFingerprint(key);if(!active.has(fingerprint))revoked.add(fingerprint);}
  const entry=entrySchema.parse({policy,history,revoked:[...revoked]});
  return this.append(id,expectedVersion,'active',policy.valid_until,entry);
 }
 async revokeKey(id:string,kid:string,expectedVersion:number){
  const old=await this.current(id);if(old.version!==expectedVersion)throw new MemoryError('authentication_conflict','Policy version changed.');
  if(!old.policy.keys.some(k=>k.kid===kid))throw new MemoryError('authentication_conflict','Key is unavailable.');
  const keys=old.policy.keys.filter(k=>k.kid!==kid);
  if(keys.length)return this.publish(id,{...old.policy,keys},expectedVersion);
  return this.revoke(id,expectedVersion);
 }
 async revoke(id:string,expectedVersion:number){
  const old=await this.read(id);if(!old||old.version!==expectedVersion)throw new MemoryError('authentication_conflict','Policy version changed.');
  const revoked=new Set(old.revoked);for(const key of old.policy.keys)revoked.add(await keyFingerprint(key));
  return this.append(id,expectedVersion,'revoked',old.policy.valid_until,entrySchema.parse({policy:old.policy,history:old.history,revoked:[...revoked]}));
 }
 private async append(id:string,expected:number,state:'active'|'revoked',until:number,entry:z.infer<typeof entrySchema>){
  const body=canonical(entry);if(new TextEncoder().encode(body).length>65536)throw new MemoryError('resource_limit','Authentication history limit reached.');
  const result=await this.db.withSession('first-primary').prepare(`INSERT INTO cloud_auth_versions
   SELECT ?,?,?,?,?,? WHERE coalesce((SELECT MAX(version) FROM cloud_auth_versions WHERE policy_id=?),0)=?`)
   .bind(id,expected+1,state,until,body,new Date(this.now()).toISOString(),id,expected).all();
  if(!result.success||result.meta.changes!==1)throw new MemoryError('authentication_conflict','Policy version changed.');
  return {version:expected+1,state};
 }
}
