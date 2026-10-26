import {createServer} from 'node:http';
import {mkdtempSync,realpathSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {Miniflare} from 'miniflare';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {D1AtomicCommitStore} from '../../dist/adapters/storage/d1/atomic-store.js';
import {D1AuthPolicies} from '../../dist/adapters/storage/d1/auth-policies.js';
import {D1ProjectAccess} from '../../dist/adapters/storage/d1/project-access.js';
import {remoteWriteTools} from '../../dist/core/access/remote-outbox.js';
import {d1WorkerModules} from './d1-modules.mjs';

export const value=r=>JSON.parse(r.content[0].text);
export async function remoteHostFixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-remote-host-'))),project=randomUUID(),scope={project_id:project,repository:'web',environment:'test'};
 const epoch=Math.floor(Date.now()/1000),issuer='https://remote-host-test.cloudflareaccess.com',pair=await generateKeyPair('RS256'),jwk={...await exportJWK(pair.publicKey),kid:'test',alg:'RS256',use:'sig'};
 let fault='none',requestCount=0,mf;
 const bridge=createServer(async(req,res)=>{
  requestCount++;
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),rpc=JSON.parse(body);
   if(fault==='offline'){res.writeHead(503).end();return;}
   const response=await mf.dispatchFetch(new URL(req.url,origin).href,{method:req.method,headers:req.headers,body}),bytes=Buffer.from(await response.arrayBuffer());
   if(fault==='lose'&&Object.values(remoteWriteTools).includes(rpc.params?.name)){fault='none';res.destroy();return;}
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(bytes);
  }catch{if(!res.destroyed)res.writeHead(503).end();}
 });
 await new Promise(r=>bridge.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${bridge.address().port}`,endpoint=`${origin}/v1/projects/${project}/mcp`;
 mf=new Miniflare({...d1WorkerModules(fileURLToPath(new URL('./cloud-mcp-worker.mjs',import.meta.url))),compatibilityDate:'2026-07-30',d1Databases:{DB:randomUUID()},d1Persist:join(root,'d1'),
  bindings:{MCP_CONFIG:{endpoint,policy_id:'remote-host-test',scope,storage_identity:'remote-host-test-store'}},host:'127.0.0.1',port:0,upstream:origin,outboundService:()=>new Response('outbound forbidden',{status:403})});
 const db=await mf.getD1Database('DB'),hash=s=>createHash('sha256').update(s).digest('hex');
 for(const name of ['001-atomic-memory.sql','002-work.sql','003-decisions-plans.sql','004-execution-evidence.sql','005-task-events.sql','006-skills.sql','007-feature-discovery.sql','008-project-transfer.sql','009-storage-origins.sql','010-project-access.sql','011-owner-key-lifecycle.sql']){
  const statements=readFileSync(new URL('../../migrations/d1/'+name,import.meta.url),'utf8').replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|INSERT\s|$)/i).filter(Boolean);await db.batch(statements.map(sql=>db.prepare(sql)));
 }
 await new D1AtomicCommitStore(db,project).commit({project:{id:project,key:'remote-host-test',name:'원격 복구 테스트',revision:0,created_at:new Date().toISOString()},expected_revision:null,receipt:{scope:project,key:'seed',hash:hash(project),result:{test_only:true}}});
 await new D1AuthPolicies(db).publish('remote-host-test',{issuer,audience:'remote-host',keys:[jwk],fetched_at:epoch-10,valid_until:epoch+3600,max_token_age_seconds:3600},0);
 const access=new D1ProjectAccess(db);for(const [subject,role]of [['alice','owner'],['viewer','viewer']])await access.grant({issuer,subject},scope,role,'active',0);
 const sign=(subject='alice',expired=false)=>new SignJWT({type:'app',iss:issuer,sub:subject,aud:['remote-host'],iat:epoch-10,exp:expired?epoch-1:epoch+1800}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(pair.privateKey);
 const token=await sign(),clients=[];
 const connect=async({credential=token,queue=join(root,'outbox.sqlite'),viewer=true,recording='on'}={})=>{
  const client=new Client({name:'remote-host-test-client',version:'1'}),args=[fileURLToPath(new URL('../../dist/runtime/local/main.js',import.meta.url)),'remote-serve','--endpoint',endpoint,'--project-id',project,'--repository',scope.repository,'--environment',scope.environment,'--outbox',queue,'--credential-env','SKILLY_TEST_ASSERTION',...(viewer?['--viewer-port','0']:[])];
  const transport=new StdioClientTransport({command:process.execPath,args,stderr:'pipe',env:{SKILLY_TEST_ASSERTION:credential,SKILLY_RECORDING:recording}});let url='';
  transport.stderr?.on('data',chunk=>{const match=chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/);if(match)url=match[0];});
  await client.connect(transport);clients.push(client);
  return {client,get url(){return url;},call:async(name,args={})=>value(await client.callTool({name,arguments:args})),close:()=>client.close()};
 };
 return {root,scope,destination:{endpoint,scope},token,sign,connect,db,access,set fault(value){fault=value;},get requests(){return requestCount;},
  all:async(sql,...args)=>(await db.withSession('first-primary').prepare(sql).bind(...args).all()).results,
  close:async()=>{for(const client of clients)await client.close();bridge.closeAllConnections();await new Promise(r=>bridge.close(r));await mf.dispose();}};
}
