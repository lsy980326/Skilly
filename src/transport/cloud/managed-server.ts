import { z } from 'zod';
import { D1AccessAuthenticator } from '../../adapters/auth/d1-access.js';
import { accessScopeSchema } from '../../core/access/model.js';
import { D1OwnerEnrollment } from '../../adapters/storage/d1/owner-enrollment.js';
import type { D1Binding } from '../../adapters/storage/d1/binding.js';
import { createCloudHandler,cloudInput,cloudResponse,cloudError } from './server.js';

const enrollmentSchema=z.strictObject({repository:z.string(),environment:z.string(),registration_id:z.uuid()});
/** Version-managed local/test handler; provisioning stays outside the public request path. */
export function createManagedCloudHandler(db:D1Binding,policyId:string){
 const authenticator=new D1AccessAuthenticator(db,policyId),memory=createCloudHandler(db,authenticator);
 return async(request:Request):Promise<Response>=>{
  const url=new URL(request.url),match=/^\/v1\/projects\/([a-fA-F0-9-]{36})\/owner$/.exec(url.pathname);
  if(!match)return memory(request);
  try{
   const auth=await authenticator.authenticate(request);await auth.assertFresh();
   if(request.method!=='POST'||url.search)return cloudResponse({error:{code:'not_found'}},404);
   const body=enrollmentSchema.parse(await cloudInput(request)),scope=accessScopeSchema.parse({project_id:match[1],repository:body.repository,environment:body.environment});
   const result=await new D1OwnerEnrollment(db).claim(auth,scope,body.registration_id);await auth.assertFresh();return cloudResponse(result);
  }catch(e){return cloudError(e);}
 };
}
