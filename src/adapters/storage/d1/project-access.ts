import { z } from 'zod';
import { AccessError,accessScopeSchema,principalSchema,roleSchema,permits,type Principal,type AccessScope,type AccessAction,type CredentialLease } from '../../../core/access/model.js';
import { MemoryError } from '../../../core/memory/model.js';
import type { D1Binding,D1Statement } from './binding.js';
import { rows } from './query.js';
import { credentialGuard,credentialError } from './credential-guard.js';

const grantSchema=z.strictObject({version:z.int().positive(),role:roleSchema,state:z.enum(['active','revoked'])});
type Grant=z.infer<typeof grantSchema>;
const latest='SELECT version,role,state FROM cloud_project_access WHERE issuer=? AND subject=? AND project_id=? AND repository=? AND environment=? ORDER BY version DESC LIMIT 1';
const values=(p:Principal,s:AccessScope)=>[p.issuer,p.subject,s.project_id,s.repository,s.environment];
/** Privileged host provisioning only; intentionally not exposed by the HTTP handler. */
export class D1ProjectAccess {
 constructor(private readonly db:D1Binding){}
 async grant(principal:Principal,scope:AccessScope,role:z.infer<typeof roleSchema>,state:'active'|'revoked',expectedVersion:number){
  const p=principalSchema.parse(principal),s=accessScopeSchema.parse(scope);roleSchema.parse(role);z.enum(['active','revoked']).parse(state);z.int().nonnegative().parse(expectedVersion);
  const result=await this.db.withSession('first-primary').prepare(`INSERT INTO cloud_project_access SELECT ?,?,?,?,?,?,?,?,?
    WHERE coalesce((SELECT MAX(version) FROM cloud_project_access WHERE issuer=? AND subject=? AND project_id=? AND repository=? AND environment=?),0)=?`)
   .bind(...values(p,s),expectedVersion+1,role,state,new Date().toISOString(),...values(p,s),expectedVersion).all();
  if(!result.success||result.meta.changes!==1)throw new MemoryError('access_conflict','Access policy changed; preserve the original expected version.');
  return {version:expectedVersion+1};
 }
 async authorize(principal:Principal,scope:AccessScope,action:AccessAction):Promise<Grant>{
  principalSchema.parse(principal);accessScopeSchema.parse(scope);
  let grant:Grant|null;try{const data=await rows(this.db,latest,values(principal,scope),1);grant=data[0]?grantSchema.parse(data[0]):null;}catch{throw new AccessError(503,'authorization_unavailable');}
  if(!grant||grant.state!=='active'||!permits(grant.role,action))throw new AccessError(403);
  return grant;
 }
 async bind(principal:Principal,scope:AccessScope,action:AccessAction,fresh:()=>void|Promise<void>,credential?:CredentialLease){
  const p=principalSchema.parse(principal),s=accessScopeSchema.parse(scope),grant=await this.authorize(p,s,action),raw=this.db;
  const check=async()=>{await fresh();const current=await this.authorize(p,s,action);if(current.version!==grant.version)throw new AccessError(403);};
  const binding:D1Binding={...(raw.writeGeneration===undefined?{}:{writeGeneration:raw.writeGeneration}),withSession:constraint=>{
   const session=raw.withSession(constraint),originals=new WeakMap<D1Statement,D1Statement>();
   const wrap=(statement:D1Statement,sql:string):D1Statement=>{const wrapped:D1Statement={bind:(...v)=>wrap(statement.bind(...v),sql),async all<T>(){
    if(!/^\s*SELECT\b/i.test(sql))throw new AccessError(403);await check();const result=await statement.all<T>();await check();return result;
   }};originals.set(wrapped,statement);return wrapped;};
   return {prepare:sql=>wrap(session.prepare(sql),sql),async batch(statements){
    if(action!=='write')throw new AccessError(403);await check();
    const native=statements.map(st=>{const item=originals.get(st);if(!item)throw new AccessError(403);return item;});
    const guard=session.prepare(`INSERT INTO cloud_access_guard VALUES(1,CASE WHEN EXISTS(SELECT 1 FROM cloud_project_access
      WHERE issuer=? AND subject=? AND project_id=? AND repository=? AND environment=? AND version=? AND state='active' AND role IN ('owner','editor')
      AND version=(SELECT MAX(version) FROM cloud_project_access WHERE issuer=? AND subject=? AND project_id=? AND repository=? AND environment=?)) THEN 1 ELSE 0 END)`)
     .bind(...values(p,s),grant.version,...values(p,s));
    const credentials=credential?credentialGuard(session,credential):[];
    try{const result=await session.batch([...credentials,guard,session.prepare('DELETE FROM cloud_access_guard WHERE id=1'),...native]);return result.slice(credentials.length+2);}
    catch(e){credentialError(e);if(e instanceof Error&&e.message.includes('skilly_cloud_access_allowed'))throw new AccessError(403);throw e;}
   }};
  }};
  return {binding,check,version:grant.version};
 }
}
