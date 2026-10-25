import { z } from 'zod';
import { AccessError,accessScopeSchema,principalSchema,type AccessScope,type Authentication,type Principal } from '../../../core/access/model.js';
import { MemoryError,type JsonObject } from '../../../core/memory/model.js';
import { D1AuthPolicies,policyIdSchema } from './auth-policies.js';
import type { D1Binding } from './binding.js';
import { credentialGuard,credentialError } from './credential-guard.js';
import { canonical,json,rows } from './query.js';

const id=z.uuid(),intentSchema=z.object({id,project_id:id,repository:z.string(),environment:z.string(),policy_id:policyIdSchema,issuer:z.string(),subject:z.string(),expires_at:z.int().positive()});
const receiptSchema=z.strictObject({status:z.literal('persisted'),registration_id:id,scope:accessScopeSchema,granted_at:z.iso.datetime(),claims_verified:z.literal(false)});
const conflict=()=>new MemoryError('owner_conflict','Initial owner enrollment is unavailable.');
/** Public intent IDs are not passwords: the host pins the exact signed principal. */
export class D1OwnerEnrollment {
 constructor(private readonly db:D1Binding,private readonly now:()=>number=()=>Date.now()){}
 async prepare(scope:AccessScope,principal:Principal,policyId:string,expiresAt:number){
  const s=accessScopeSchema.parse(scope),p=principalSchema.parse(principal),policy=await new D1AuthPolicies(this.db,this.now).current(policyId),now=Math.floor(this.now()/1000);
  z.int().positive().parse(expiresAt);if(p.issuer!==policy.policy.issuer||expiresAt<=now||expiresAt>now+3600)throw conflict();
  const registrationId=crypto.randomUUID();
  try{
   const result=await this.db.withSession('first-primary').prepare(`INSERT INTO cloud_owner_intents SELECT ?,?,?,?,?,?,?,?,?
    WHERE NOT EXISTS(SELECT 1 FROM cloud_project_access WHERE project_id=? AND repository=? AND environment=?)`)
    .bind(registrationId,s.project_id,s.repository,s.environment,policyId,p.issuer,p.subject,expiresAt,new Date(this.now()).toISOString(),s.project_id,s.repository,s.environment).all();
   if(!result.success||result.meta.changes!==1)throw conflict();
  }catch{throw conflict();}
  return {registration_id:registrationId,expires_at:expiresAt};
 }
 async claim(auth:Authentication,scope:AccessScope,registrationId:string):Promise<JsonObject>{
  const s=accessScopeSchema.parse(scope);id.parse(registrationId);await auth.assertFresh();
  const credential=auth.credential;if(!credential)throw new AccessError(403);
  const [row]=await rows(this.db,`SELECT * FROM cloud_owner_intents WHERE id=? AND project_id=? AND repository=? AND environment=?`,[registrationId,s.project_id,s.repository,s.environment],1);
  if(!row)throw new AccessError(403);const intent=intentSchema.parse(row);
  if(intent.issuer!==auth.principal.issuer||intent.subject!==auth.principal.subject||intent.policy_id!==credential.policy_id)throw new AccessError(403);
  const receipt=async()=>{const [r]=await rows(this.db,'SELECT result_json FROM cloud_owner_claims WHERE intent_id=?',[registrationId],1);if(!r)return null;
   const parsed=receiptSchema.parse(JSON.parse(z.string().max(2048).parse(r['result_json'])));
   if(parsed.registration_id!==registrationId||canonical(parsed.scope)!==canonical(s))throw new AccessError(503,'authorization_unavailable');return json(parsed);};
  const saved=await receipt();if(saved){await auth.assertFresh();return saved;}
  if(intent.expires_at<=Math.floor(this.now()/1000))throw conflict();
  const at=new Date(this.now()).toISOString(),result=receiptSchema.parse({status:'persisted',registration_id:registrationId,scope:s,granted_at:at,claims_verified:false}),session=this.db.withSession('first-primary');
  try{
   await session.batch([...credentialGuard(session,credential),session.prepare(`INSERT INTO cloud_project_access SELECT ?,?,?,?,?,1,'owner','active',?
    WHERE NOT EXISTS(SELECT 1 FROM cloud_project_access WHERE project_id=? AND repository=? AND environment=?)
    AND EXISTS(SELECT 1 FROM cloud_owner_intents WHERE id=? AND expires_at>unixepoch())`)
    .bind(intent.issuer,intent.subject,s.project_id,s.repository,s.environment,at,s.project_id,s.repository,s.environment,registrationId),
    session.prepare('INSERT INTO cloud_owner_guard VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)'),session.prepare('DELETE FROM cloud_owner_guard WHERE id=1'),
    session.prepare('INSERT INTO cloud_owner_claims VALUES(?,?,?)').bind(registrationId,canonical(result),at)]);
  }catch(e){
   credentialError(e);await auth.assertFresh();const concurrent=await receipt();if(concurrent)return concurrent;
   if(e instanceof Error&&e.message.includes('skilly_cloud_owner_allowed'))throw conflict();
   throw new MemoryError('persistence_unknown','Enrollment receipt is not confirmed. Retry the original registration.');
  }
  await auth.assertFresh();const persisted=await receipt();
  if(!persisted)throw new MemoryError('persistence_unknown','Enrollment receipt is not confirmed. Retry the original registration.');
  return persisted;
 }
}
