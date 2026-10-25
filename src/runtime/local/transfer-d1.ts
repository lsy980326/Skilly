import { closeSync,existsSync,readFileSync,readdirSync,lstatSync } from 'node:fs';
import { join,relative } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { D1Binding } from '../../adapters/storage/d1/binding.js';
import { safePath,newDirectory,writeNew,fileDescriptor,fail } from '../../adapters/storage/transfer/files.js';
import { storeIdentity } from '../../adapters/storage/d1/transfer-store.js';

// Fixed bundled DDL only. Neither imported records nor persisted options select code/SQL.
export function transferMigrations(){
 const root=new URL('../../../migrations/d1/',import.meta.url);
 const names=readdirSync(root).filter(n=>/^00[1-9]-[a-z-]+\.sql$/.test(n)).sort();
 if(names.length!==9)fail('unsupported_capability','The explicit D1 001–009 schema is required.');
 const texts=names.map(n=>readFileSync(new URL(n,root),'utf8'));
 return {hash:createHash('sha256').update(JSON.stringify(texts)).digest('hex'),statements:texts.flatMap(s=>s.replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|INSERT\s|$)/i).filter(Boolean))};
}
const endpointSchema=z.strictObject({version:z.literal(1),operation:z.uuid(),schema_hash:z.string().regex(/^[a-f0-9]{64}$/)});
type Emulator={getD1Database(name:string):Promise<D1Binding>;dispose():Promise<void>};
// Optional development dependency: validate only this host boundary. Its bundled declarations
// require a different Workers/Zod type graph; do not disable project-wide library checks.
const runtimeSchema=z.object({Miniflare:z.custom<new(options:Record<string,unknown>)=>Emulator>(v=>typeof v==='function'),
 Log:z.custom<new(level:number)=>object>(v=>typeof v==='function'),LogLevel:z.object({NONE:z.number()})});
const readySchema=z.strictObject({store_id:z.string().regex(/^[a-f0-9]{32}$/),file:z.string().regex(/^data\/[a-zA-Z0-9_./-]+\.sqlite$/).refine(v=>!v.split('/').includes('..')),dev:z.number(),ino:z.number()});
function readReady(path:string){const fd=fileDescriptor(join(path,'endpoint-ready.json'),4096);try{return readySchema.parse(JSON.parse(readFileSync(fd,'utf8')));}finally{closeSync(fd);}}
function databaseFile(path:string){
 const found:string[]=[];let visited=0;
 const visit=(dir:string,depth:number)=>{safePath(dir);if(++visited>32||depth>4)fail('invalid_transfer','Unexpected local D1 persistence layout.');for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);safePath(p);if(e.isDirectory())visit(p,depth+1);else if(e.isFile()&&/^[a-f0-9]{64}\.sqlite$/.test(e.name))found.push(p);}};
 visit(join(path,'data'),0);if(found.length!==1)fail('invalid_transfer','Expected exactly one local D1 database.');return found[0]!;
}
export async function openTransferD1(path:string,operation:string,schemaHash:string,create:boolean){
 safePath(path);const marker=join(path,'local-d1.json');
 if(!existsSync(path)){
  if(!create)fail('not_found','Local D1 is absent. Status/resume never creates a replacement target.');
  newDirectory(path);writeNew(marker,JSON.stringify({version:1,operation,schema_hash:schemaHash}));
 }
 const fd=fileDescriptor(marker,4096);try{const m=endpointSchema.parse(JSON.parse(readFileSync(fd,'utf8')));if(m.operation!==operation||m.schema_hash!==schemaHash)fail('authority_conflict','Local D1 endpoint belongs to a different operation/schema.');}finally{closeSync(fd);}
 const ready=existsSync(join(path,'endpoint-ready.json'))?readReady(path):null;
 if(ready){const file=join(path,ready.file);closeSync(fileDescriptor(file));const stat=lstatSync(file);if(stat.dev!==ready.dev||stat.ino!==ready.ino)fail('authority_conflict','Local D1 file was replaced. No replacement endpoint opened.');}
 else if(!create)fail('not_found','Local D1 initialization is incomplete. Retry the original execute; no replacement opened.');
 const migrations=transferMigrations();if(migrations.hash!==schemaHash)fail('unsupported_capability','The migration set changed; no endpoint was upgraded.');
 let runtime:z.infer<typeof runtimeSchema>;
 try{const specifier='miniflare',loaded:unknown=await import(specifier);runtime=runtimeSchema.parse(loaded);}catch{ return fail('unsupported_capability','Local D1 commands require the installed Miniflare development runtime; nothing was downloaded.'); }
 const mf=new runtime.Miniflare({modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',
  compatibilityDate:'2026-07-30',d1Databases:{DB:'skilly-project-transfer'},d1Persist:join(path,'data'),host:'127.0.0.1',port:0,
  log:new runtime.Log(runtime.LogLevel.NONE),outboundService:()=>new Response('Outbound disabled',{status:403})});
 try{
  const db=await mf.getD1Database('DB'),session=db.withSession('first-primary');
  const objects=(await session.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results;
  if(!objects.length){if(!create||ready)fail('not_found','Local D1 business schema is absent; no replacement was initialized.');
   await session.batch(migrations.statements.map(s=>session.prepare(s)));}
  else if(!(await session.prepare("SELECT name FROM sqlite_master WHERE name='storage_origins'").all()).results.length)fail('unsupported_capability','Incomplete/unsupported local D1 schema; no automatic upgrade.');
  const identity=await storeIdentity(db);if(ready&&identity!==ready.store_id)fail('authority_conflict','Local D1 store identity changed.');
  if(!ready){const file=databaseFile(path),stat=lstatSync(file);writeNew(join(path,'endpoint-ready.json'),JSON.stringify({store_id:identity,file:relative(path,file),dev:stat.dev,ino:stat.ino}));}
  return {db,close:()=>mf.dispose()};
 }catch(e){await mf.dispose();throw e;}
}
