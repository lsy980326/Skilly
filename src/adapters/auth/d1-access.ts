import { AccessError,type Authentication,type Authenticator } from '../../core/access/model.js';
import { D1AuthPolicies,policyIdSchema } from '../storage/d1/auth-policies.js';
import type { D1Binding } from '../storage/d1/binding.js';
import { CloudflareAccessAuthenticator } from './cloudflare-access.js';

/** Re-reads the host policy even when this handler survives key rotation. */
export class D1AccessAuthenticator implements Authenticator {
 private readonly policies:D1AuthPolicies;
 constructor(db:D1Binding,private readonly policyId:string,private readonly now:()=>number=()=>Date.now()){
  policyIdSchema.parse(policyId);this.policies=new D1AuthPolicies(db,now);
 }
 async authenticate(request:Request):Promise<Authentication>{
  if(!request.headers.get('Cf-Access-Jwt-Assertion'))throw new AccessError(401,'unauthenticated');
  const entry=await this.policies.current(this.policyId),auth=await new CloudflareAccessAuthenticator(entry.policy,this.now).authenticate(request);
  const expires=Math.min(auth.expires_at,entry.policy.valid_until);
  const assertFresh=async()=>{await auth.assertFresh();const latest=await this.policies.current(this.policyId);if(latest.version!==entry.version)throw new AccessError(401,'authentication_changed');};
  await assertFresh();
  return {principal:auth.principal,expires_at:expires,assertFresh,credential:{policy_id:this.policyId,version:entry.version,expires_at:expires}};
 }
}
