import { createLocalJWKSet,jwtVerify } from 'jose';
import { z } from 'zod';
import { AccessError,principalSchema,type Authenticator,type Authentication } from '../../core/access/model.js';

const publicKey=z.strictObject({kty:z.literal('RSA'),kid:z.string().min(1).max(200),alg:z.literal('RS256'),use:z.literal('sig'),
 n:z.string().regex(/^[A-Za-z0-9_-]{342,1400}$/),e:z.literal('AQAB'),key_ops:z.array(z.literal('verify')).length(1).optional()});
const policySchema=z.strictObject({issuer:z.string().regex(/^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/),
 audience:z.string().min(1).max(200),keys:z.array(publicKey).min(1).max(4),fetched_at:z.int().nonnegative(),valid_until:z.int().positive(),max_token_age_seconds:z.int().min(60).max(2592000)});
export type AccessPolicy=z.infer<typeof policySchema>;
/** Public host-provided keys only. No token-directed URL, remote JWKS fetch, cookie fallback or account setup. */
export class CloudflareAccessAuthenticator implements Authenticator {
 private readonly policy:AccessPolicy;
 private readonly jwks:ReturnType<typeof createLocalJWKSet>;
 constructor(policy:AccessPolicy,private readonly now:()=>number=()=>Date.now()){
  this.policy=policySchema.parse(structuredClone(policy));
  if(new Set(this.policy.keys.map(k=>k.kid)).size!==this.policy.keys.length||this.policy.valid_until<=this.policy.fetched_at||this.policy.valid_until-this.policy.fetched_at>86400)throw new AccessError(503,'authentication_unavailable');
  this.jwks=createLocalJWKSet({keys:this.policy.keys.map(k=>({kty:k.kty,kid:k.kid,alg:k.alg,use:k.use,n:k.n,e:k.e,key_ops:k.key_ops??['verify']}))});
 }
 private fresh(){const at=Math.floor(this.now()/1000);if(at<this.policy.fetched_at||at>=this.policy.valid_until)throw new AccessError(503,'authentication_unavailable');return at;}
 async authenticate(request:Request):Promise<Authentication>{
  const token=request.headers.get('Cf-Access-Jwt-Assertion');
  if(!token||token.length>16384)throw new AccessError(401,'unauthenticated');
  const at=this.fresh();
  try{
   const {payload,protectedHeader}=await jwtVerify(token,this.jwks,{algorithms:['RS256'],issuer:this.policy.issuer,audience:this.policy.audience,
    requiredClaims:['iss','sub','aud','exp','iat'],maxTokenAge:this.policy.max_token_age_seconds,currentDate:new Date(at*1000),clockTolerance:0});
   if(!protectedHeader.kid||protectedHeader.jku||protectedHeader.jwk||protectedHeader.x5u||payload['type']!=='app'
    ||typeof payload.exp!=='number'||typeof payload.iat!=='number'||!Number.isSafeInteger(payload.exp)||!Number.isSafeInteger(payload.iat)
    ||payload.exp<=payload.iat||payload.exp-payload.iat>this.policy.max_token_age_seconds)throw new AccessError(401,'unauthenticated');
   const principal=principalSchema.parse({issuer:payload.iss,subject:payload.sub}),expires=payload.exp;
   return {principal,assertFresh:()=>{if(this.fresh()>=expires)throw new AccessError(401,'unauthenticated');}};
  }catch(e){if(e instanceof AccessError)throw e;throw new AccessError(401,'unauthenticated');}
 }
}
