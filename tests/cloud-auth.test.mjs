import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {CloudflareAccessAuthenticator} from '../dist/adapters/auth/cloudflare-access.js';
import {createCloudHandler} from '../dist/transport/cloud/server.js';

const at=2000000000,issuer='https://skilly-test.cloudflareaccess.com',audience='local-test-only';
const pair=await generateKeyPair('RS256',{modulusLength:2048}),key={...await exportJWK(pair.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
const policy={issuer,audience,keys:[key],fetched_at:at-60,valid_until:at+3600,max_token_age_seconds:3600};
const signed=(claims={},header={})=>new SignJWT({type:'app',iss:issuer,sub:'test-subject',aud:[audience],iat:at-10,nbf:at-10,exp:at+600,...claims}).setProtectedHeader({alg:'RS256',kid:'test-key',typ:'JWT',...header}).sign(pair.privateKey,{crit:{'not-supported':true}});
const request=token=>new Request('https://local.invalid/v1/projects/00000000-0000-4000-8000-000000000001/memory',{method:'POST',headers:token?{'Cf-Access-Jwt-Assertion':token}:{}});
const auth=new CloudflareAccessAuthenticator(policy,()=>at*1000);

test('only a signed app JWT with exact issuer/audience/time yields a principal',async()=>{
 const result=await auth.authenticate(request(await signed({email:'ignored@example.invalid',role:'owner'})));assert.deepEqual(result.principal,{issuer,subject:'test-subject'});result.assertFresh();
 const snapshot=structuredClone(policy),instance=new CloudflareAccessAuthenticator(snapshot,()=>at*1000);snapshot.keys[0].n='A'.repeat(342);assert.equal((await instance.authenticate(request(await signed()))).principal.subject,'test-subject');
});

test('invalid claims, headers, signatures and credentials are denied without key fetch',async t=>{
 const variants=[['wrong issuer',{iss:'https://other.cloudflareaccess.com'}],['wrong audience',{aud:['other']}],['expired',{exp:at}],['future nbf',{nbf:at+1}],['future issued',{iat:at+1}],['missing subject',{sub:undefined}],['service token',{sub:'',common_name:'test-service.access'}],['missing expiry',{exp:undefined}],['missing iat',{iat:undefined}],['org token',{type:'org'}],['excessive lifetime',{exp:at+4000}],['old token',{iat:at-4001,exp:at+1}]];
 for(const [name,claims] of variants)await t.test(name,async()=>assert.rejects(auth.authenticate(request(await signed(claims))),{status:401}));
 for(const header of [{kid:'unknown'},{jku:'https://do-not-fetch.invalid/keys'},{x5u:'https://do-not-fetch.invalid/cert'},{jwk:key},{crit:['not-supported'],'not-supported':true}])await t.test('reject header '+Object.keys(header)[0],async()=>assert.rejects(auth.authenticate(request(await signed({},header))),{status:401}));
 await t.test('missing and oversized',async()=>{await assert.rejects(auth.authenticate(request()),{status:401});await assert.rejects(auth.authenticate(request('x'.repeat(16385))),{status:401});});
 await t.test('none and symmetric algorithm',async()=>{const token=await signed(),parts=token.split('.');parts[0]=Buffer.from(JSON.stringify({alg:'none',kid:'test-key'})).toString('base64url');await assert.rejects(auth.authenticate(request(parts.slice(0,2).join('.')+'.')),{status:401});const hs=await new SignJWT({sub:'test-subject'}).setProtectedHeader({alg:'HS256',kid:'test-key'}).sign(new Uint8Array(32));await assert.rejects(auth.authenticate(request(hs)),{status:401});});
 await t.test('tampering and duplicate assertion',async()=>{const token=await signed(),parts=token.split('.');parts[1]=Buffer.from(JSON.stringify({type:'app',iss:issuer,sub:'other',aud:[audience],iat:at-10,exp:at+600})).toString('base64url');await assert.rejects(auth.authenticate(request(parts.join('.'))),{status:401});await assert.rejects(auth.authenticate(request(token+','+token)),{status:401});});
});

test('stale key snapshots fail closed and an authenticated request can expire',async()=>{
 const token=await signed();await assert.rejects(new CloudflareAccessAuthenticator(policy,()=>policy.valid_until*1000).authenticate(request(token)),{status:503});
 let now=at;const session=await new CloudflareAccessAuthenticator(policy,()=>now*1000).authenticate(request(token));now=at+600;assert.throws(()=>session.assertFresh(),{status:401});
 for(const keys of [[{...key,d:'private-fields-not-accepted'}],[key,key],[{...key,use:'enc'}],[{...key,key_ops:['sign']}],[{...key,alg:'HS256'}]])assert.throws(()=>new CloudflareAccessAuthenticator({...policy,keys},()=>at*1000));
});

test('unauthenticated HTTP requests cannot touch storage or bypass auth using other headers/body',async()=>{
 let calls=0;const db={withSession(){calls++;throw Error('storage must not be touched');}},handler=createCloudHandler(db,auth);
 for(const headers of [{},{'Cf-Access-Authenticated-User-Email':'owner@example.invalid'},{Authorization:'Bearer fake'},{Cookie:'CF_Authorization=fake'}]){const r=await handler(new Request('https://local.invalid/v1/projects/00000000-0000-4000-8000-000000000001/memory',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({authenticated:true,role:'owner'})}));assert.equal(r.status,401);assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(await r.text(),'{"error":{"code":"unauthenticated"}}');}assert.equal(calls,0);
});

test('malformed or unavailable access policy is a sanitized service error',async()=>{
 const jwt=await signed(),makeRequest=()=>new Request('https://local.invalid/v1/projects/00000000-0000-4000-8000-000000000001/memory',{method:'POST',headers:{'Content-Type':'application/json','Cf-Access-Jwt-Assertion':jwt},body:JSON.stringify({repository:'web',environment:'test',command:{operation:'tasks',input:{}}})});
 for(const all of [async()=>({success:true,results:[{version:'corrupt',role:'owner',state:'active'}],meta:{changes:0}}),async()=>{throw Error('private SQL must not be returned');}]){const db={withSession(){return {prepare(){return {bind(){return {all};}};}};}};const r=await createCloudHandler(db,auth)(makeRequest());assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:{code:'authorization_unavailable'}});}
});
