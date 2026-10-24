import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {D1Skills} from '../dist/adapters/storage/d1/skills.js';
import {D1AtomicCommitStore} from '../dist/adapters/storage/d1/atomic-store.js';
import {skillContentHash} from '../dist/core/skills/model.js';
import {parseSkillPackage} from '../dist/core/skills/package.js';
import {LocalSkillObserver} from '../dist/adapters/skills/local-observer.js';
import {d1WorkerModules} from './support/d1-modules.mjs';
const at='2026-10-25T00:00:00.000Z',hash=x=>createHash('sha256').update(x).digest('hex');
function fault(db,c){return {withSession(constraint){const s=db.withSession(constraint);return {
 prepare(sql){if(c.committed&&c.blockReceipt&&sql.startsWith('SELECT payload_hash'))return {bind(){return this;},async all(){throw Error('injected unavailable receipt');}};return s.prepare(sql);},
 async batch(statements){c.count=statements.length;const submitted=[...statements];if(c.failBefore!==undefined)submitted.splice(c.failBefore,0,s.prepare('INSERT INTO skill_fault VALUES(0)'));
 if(c.beforeBatch){const hook=c.beforeBatch;c.beforeBatch=null;await hook();}const result=await s.batch(submitted);c.committed=true;
 if(c.loseResponse){c.loseResponse=false;throw Error('injected response loss');}return result;}
 };}};}
test('actual local D1 skill catalog, immutable packages, host file observations and task reports',{timeout:150000},async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-d1-skills-')));
 const options={...d1WorkerModules(fileURLToPath(new URL('./support/d1-runtime-worker.mjs',import.meta.url))),compatibilityDate:'2026-07-30',d1Databases:{DB:randomUUID()},d1Persist:join(root,'d1'),host:'127.0.0.1',port:0,outboundService:()=>new Response('external fetch disabled',{status:403})};
 let mf=new Miniflare(options);t.after(()=>mf.dispose());let db=await mf.getD1Database('DB');
 const all=async(sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
 const apply=async names=>{for(const name of names){const sql=readFileSync(new URL('../migrations/d1/'+name,import.meta.url),'utf8').replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|$)/i).filter(Boolean);await db.batch(sql.map(s=>db.prepare(s)));}};
 await apply(['001-atomic-memory.sql','002-work.sql','003-decisions-plans.sql','004-execution-evidence.sql','005-task-events.sql']);
 const receipt=p=>{const key=randomUUID();return {scope:p.id,key,hash:hash(key),result:{status:'persisted'}};};
 const mutation=async(f,extra={})=>{const rev=(await all('SELECT revision FROM projects WHERE id=?',f.p.id))[0].revision;return {project:{...f.p,revision:rev+1},expected_revision:rev,receipt:receipt(f.p),...extra};};
 const seed=async()=>{const p={id:randomUUID(),key:'skills-'+randomUUID(),name:'스킬 테스트',revision:0,created_at:at},store=new D1AtomicCommitStore(db,p.id);
 await store.commit({project:p,expected_revision:null,receipt:receipt(p)});
 const run={id:randomUUID(),project_id:p.id,goal:'테스트용 스킬 사용',mode:'change',repository:'api',environment:'test',state:'active',created_at:at,updated_at:at};
 const scope={project_id:p.id,repository:'api',environment:'test',root_hash:hash(root)};const f={p,run,scope,store};await store.commit(await mutation(f,{run}));return {...f,skills:new D1Skills(db,scope)};};
 const reg=(f,extra={})=>({project_id:f.p.id,skill_key:'review-guide',version:'1',source:'local:review',name:'리뷰 안내',description:'테스트 전문',body:'# 한글 스킬\n\n본문을 실행하지 않습니다.\n',
 files:[{path:'references/Z.md',content:'참고\n'},{path:'scripts/a.mjs',content:'throw Error("never execute");\n'}],install_instructions:'검토한 패키지를 프로젝트에 별도로 설치',idempotency_key:randomUUID(),...extra});
 const assign=(extra={})=>({skill_key:'review-guide',version:'1',tool:'codex',folder:'review-guide',expected_assignment_id:null,idempotency_key:randomUUID(),...extra});
 const report=(f,extra={})=>({run_id:f.run.id,topic:'skill-test',kind:'change',body:'테스트용 작업을 수행했습니다.',report:{title:'테스트 작업',summary:'등록된 스킬을 참고했다고 보고합니다.'},
 skill_usage:[{skill_key:'review-guide',version:'1',purpose:'테스트 검토'}],idempotency_key:randomUUID(),...extra});
 const worker=async(input,status=200)=>{const res=await mf.dispatchFetch('http://local-skills.invalid/',{method:'POST',body:JSON.stringify({...input,project_id:input.scope.project_id})});const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return body;};
 const tables=['projects','runs','records','receipts','record_reports','skill_versions','skill_installations','skill_assignments','skill_observations','task_skill_usage','skilly_write_assertions'];
 const snapshot=async()=>JSON.stringify(await Promise.all(tables.map(table=>all(`SELECT * FROM ${table} ORDER BY 1,2`))));
 await t.test('005 reports unsupported without auto-install or empty success',async()=>{const f=await seed();assert.equal((await f.skills.list()).status,'unsupported');
 assert.equal((await f.skills.taskSkills(f.run.id)).schema_supported,false);await assert.rejects(f.skills.register(reg(f)),{code:'unsupported_capability'});await assert.rejects(f.skills.assign(assign()),{code:'unsupported_capability'});});
 await apply(['006-skills.sql']);await db.prepare('CREATE TABLE skill_fault(ok INTEGER NOT NULL CHECK(ok=1)) STRICT').run();
 await t.test('actual Worker preserves full package text/hash and Node share format without executing scripts',async()=>{const f=await seed(),i=reg(f);const saved=await worker({operation:'skill-register',scope:f.scope,input:i});
 assert.equal(saved.content_hash,skillContentHash(i.body,i.files));assert.equal(saved.claims_verified,false);
 const d=await worker({operation:'skill',scope:f.scope,key:i.skill_key,version:'1'});assert.equal(d.skill.body,i.body);assert.deepEqual(d.skill.files,i.files);assert.equal(d.content_is_untrusted,true);
 const pkg=await worker({operation:'skill-package',scope:f.scope,key:i.skill_key,version:'1'});assert.equal(parseSkillPackage(pkg).content_hash,saved.content_hash);for(const forbidden of ['project_id','root_hash','installation_id','idempotency_key'])assert.equal(forbidden in pkg,false);
 assert.equal((await worker({operation:'skills',scope:f.scope})).items.length,1);});
 await t.test('same requests replay, immutable versions and source conflicts preserve all original data',async()=>{const f=await seed(),i=reg(f),saved=await f.skills.register(i);assert.deepEqual(await f.skills.register(i),saved);
 await assert.rejects(f.skills.register({...i,body:'changed'}),{code:'idempotency_conflict'});
 const before=await snapshot();await assert.rejects(f.skills.register({...i,name:'changed',idempotency_key:randomUUID()}),{code:'version_conflict'});await assert.rejects(f.skills.register({...i,version:'2',source:'other:owner',idempotency_key:randomUUID()}),{code:'source_conflict'});assert.equal(await snapshot(),before);
 await f.skills.register({...i,idempotency_key:randomUUID()});assert.equal((await f.skills.list()).items[0].versions,1);
 await assert.rejects(f.skills.register({...i,project_id:randomUUID()}),{code:'scope_mismatch'});});
 await t.test('assignment choices are explicit, append-only, scoped and reset current observation state',async()=>{const f=await seed();await f.skills.register(reg(f));await f.skills.register(reg(f,{version:'2',body:'new version'}));const i=assign(),saved=await f.skills.assign(i);assert.deepEqual(await f.skills.assign(i),saved);
 await assert.rejects(f.skills.assign(assign({version:'2'})),{code:'assignment_conflict'});const next=await f.skills.assign(assign({version:'2',expected_assignment_id:saved.assignment_id}));assert.equal(next.installation_id,saved.installation_id);assert.notEqual(next.assignment_id,saved.assignment_id);
 const d=await f.skills.detail('review-guide','1');assert.equal(d.installations[0].version,'2');assert.equal(d.installations[0].state,'not_checked');assert.equal((await f.skills.history(saved.installation_id,'assignments')).items.length,2);
 const other=new D1Skills(db,{...f.scope,root_hash:hash('other root')});assert.equal((await other.detail('review-guide','1')).installations.length,0);await assert.rejects(other.history(saved.installation_id,'assignments'),{code:'scope_mismatch'});});
 function localProvider(counter){const local=new LocalSkillObserver(root);return {root_hash:hash(root),async observe(i,v){counter.calls++;return local.observe({...i,project_root:root,assigned_at:at},v);}};}
 function putPackage(i){const base=join(root,'.agents','skills','review-guide');mkdirSync(base,{recursive:true});writeFileSync(join(base,'SKILL.md'),i.body);for(const f of i.files){mkdirSync(join(base,f.path,'..'),{recursive:true});writeFileSync(join(base,f.path),f.content);}return base;}
 let observed;
 await t.test('real local file observer feeds D1, saved requests replay without re-reading and queries do not observe files',async()=>{const f=await seed(),i=reg(f);await f.skills.register(i);const a=await f.skills.assign(assign());const base=putPackage(i),counter={calls:0},skills=new D1Skills(db,f.scope,localProvider(counter));
 const input={installation_id:a.installation_id,idempotency_key:randomUUID()},o=await skills.inspect(input);assert.equal(o.state,'matches');assert.equal(counter.calls,1);writeFileSync(join(base,'SKILL.md'),'locally changed');assert.deepEqual(await skills.inspect(input),o);assert.equal(counter.calls,1);
 const d=await skills.detail('review-guide','1');assert.equal(d.installations[0].state,'matches');assert.equal(counter.calls,1);assert.equal(d.installations[0].loading_status,'unknown');assert.equal(d.installations[0].current_machine_verified,false);
 const modified=await skills.inspect({...input,idempotency_key:randomUUID()});assert.equal(modified.state,'modified');assert.equal(counter.calls,2);assert.equal((await skills.history(a.installation_id,'observations')).items.length,2);
 await assert.rejects(f.skills.inspect({...input,idempotency_key:randomUUID()}),{code:'observation_provider_required'});assert.throws(()=>new D1Skills(db,f.scope,{...localProvider(counter),root_hash:hash('wrong')}),{code:'scope_mismatch'});
 observed={f,i,a,o,modified,skills,base,counter};});
 await t.test('AI use reports and explicit original file evidence remain separate through assignment changes and corrections',async()=>{const {f,o,a,skills}=observed;const only=await worker({operation:'skill-checkpoint',scope:f.scope,input:report(f)});const withFile=await skills.checkpoint(report(f,{skill_usage:[{skill_key:'review-guide',version:'1',purpose:'명시 관측 연결',observation_id:o.observation_id}]}));
 const read=await skills.taskSkills(f.run.id);assert.equal(read.items[0].file_observation.id,o.observation_id);assert.equal(read.items[0].file_observation.state,'matches');assert.equal(read.items[0].provenance,'agent_report');assert.equal(read.items[1].file_observation,null);assert.equal(read.claims_verified,false);assert.equal(read.loading_status,'unknown');
 await f.skills.register(reg(f,{version:'2',body:'updated'}));await f.skills.assign(assign({version:'2',expected_assignment_id:a.assignment_id}));assert.equal((await skills.detail('review-guide')).installations[0].state,'not_checked');assert.equal((await skills.taskSkills(f.run.id)).items[0].file_observation.id,o.observation_id);
 await skills.checkpoint(report(f,{supersedes:only.record_id,body:'이전 사용 보고를 정정합니다.',report_origin:'retrospective'}));const after=await skills.taskSkills(f.run.id);assert.equal(after.items.find(x=>x.record_id===only.record_id).report_state,'superseded');assert.equal(after.items[0].report_origin,'retrospective');
 assert.equal((await all('SELECT count(*) n FROM task_skill_usage WHERE record_id=?',withFile.record_id))[0].n,1);});
 await t.test('foreign project/root/repository/version observations and unknown versions cannot be attached',async()=>{const {f,o}=observed,g=await seed();await g.skills.register(reg(g));
 const invalid=report(g,{skill_usage:[{skill_key:'review-guide',version:'1',purpose:'invalid scope',observation_id:o.observation_id}]});const before=await snapshot();await assert.rejects(g.skills.checkpoint(invalid),{code:'scope_mismatch'});
 await assert.rejects(new D1Skills(db,{...f.scope,root_hash:hash('other')}).checkpoint(report(f,{skill_usage:invalid.skill_usage})),{code:'scope_mismatch'});
 await assert.rejects(f.skills.checkpoint(report(f,{skill_usage:[{skill_key:'review-guide',version:'2',purpose:'wrong version',observation_id:o.observation_id}]})),{code:'scope_mismatch'});
 await assert.rejects(f.skills.checkpoint(report(f,{skill_usage:[{skill_key:'absent',version:'1',purpose:'unknown'}]})),{code:'not_found'});assert.equal(await snapshot(),before);});
 await t.test('another host root retains AI reports but omits foreign file evidence without rewriting history',async()=>{const {f,o}=observed;
 const other=new D1Skills(db,{...f.scope,root_hash:hash('different working folder')}),read=await other.taskSkills(f.run.id);
 assert.ok(read.items.some(x=>x.file_observation_status==='outside_host_root'));assert.ok(read.items.every(x=>x.file_observation===null));
 assert.equal(JSON.stringify(read).includes(o.observation_id),false);assert.equal(JSON.stringify(read).includes(f.scope.root_hash),false);
 assert.ok((await f.skills.taskSkills(f.run.id)).items.some(x=>x.file_observation?.id===o.observation_id));});
 await t.test('CAS cannot commit a stale skill owner or use report after another connection closes the task',async()=>{const f=await seed(),i=reg(f);
 const c={beforeBatch:async()=>{await f.skills.register({...i,source:'different:source',idempotency_key:randomUUID()});}};
 await assert.rejects(new D1Skills(fault(db,c),f.scope).register(i),{code:'source_conflict'});
 const g=await seed();await g.skills.register(reg(g));const before=(await all('SELECT count(*) n FROM records WHERE project_id=?',g.p.id))[0].n;
 const closing={beforeBatch:async()=>{await g.store.commit(await mutation(g,{run:{...g.run,state:'completed'}}));}};
 await assert.rejects(new D1Skills(fault(db,closing),g.scope).checkpoint(report(g)),{code:'run_closed'});
 assert.equal((await all('SELECT count(*) n FROM records WHERE project_id=?',g.p.id))[0].n,before);});
 await t.test('every SQL catalog/assignment/observation/report boundary rolls back originals, indexes and receipts together',async()=>{for(const op of ['register','assign','inspect','checkpoint']){const f=await seed(),counter={calls:0};if(op!=='register')await f.skills.register(reg(f));let installation;
 if(op==='inspect'){installation=await f.skills.assign(assign());putPackage(reg(f));}
 const perform=(skills)=>op==='register'?skills.register(reg(f,{skill_key:'other-guide'})):op==='assign'?skills.assign(assign()):op==='inspect'?skills.inspect({installation_id:installation.installation_id,idempotency_key:randomUUID()}):skills.checkpoint(report(f));
 const baseline={};await perform(new D1Skills(fault(db,baseline),f.scope,localProvider(counter)));
 for(let pos=0;pos<=baseline.count;pos++){const before=await snapshot(),c={failBefore:pos};
 const skills=new D1Skills(fault(db,c),f.scope,localProvider(counter));
 if(op==='assign')await assert.rejects(skills.assign(assign({folder:'new-slot-'+pos})));else if(op==='register')await assert.rejects(skills.register(reg(f,{skill_key:'fail-'+pos})));else await assert.rejects(perform(skills));
 assert.equal(await snapshot(),before,op+':'+pos);}
 }});
 await t.test('concurrent assignment during inspection rejects the frozen result without silently sampling again',async()=>{const f=await seed();await f.skills.register(reg(f));await f.skills.register(reg(f,{version:'2'}));const a=await f.skills.assign(assign());putPackage(reg(f));const counter={calls:0};
 const c={beforeBatch:async()=>{await f.skills.assign(assign({version:'2',expected_assignment_id:a.assignment_id}));}};
 await assert.rejects(new D1Skills(fault(db,c),f.scope,localProvider(counter)).inspect({installation_id:a.installation_id,idempotency_key:randomUUID()}),{code:'assignment_conflict'});assert.equal(counter.calls,1);assert.equal((await f.skills.history(a.installation_id,'observations')).items.length,0);});
 await t.test('lost responses and temporarily unavailable receipts recover exact saved observation and report IDs',async()=>{const f=await seed();await f.skills.register(reg(f));const a=await f.skills.assign(assign());putPackage(reg(f));const counter={calls:0},c={loseResponse:true,blockReceipt:true},input={installation_id:a.installation_id,idempotency_key:randomUUID()};
 await assert.rejects(new D1Skills(fault(db,c),f.scope,localProvider(counter)).inspect(input),{code:'persistence_unknown'});assert.equal(counter.calls,1);
 const read=await f.skills.history(a.installation_id,'observations'),saved=await new D1Skills(db,f.scope,localProvider(counter)).inspect(input);assert.equal(saved.observation_id,read.items[0].id);assert.equal(counter.calls,1);
 const request=report(f),c2={loseResponse:true,blockReceipt:true};await assert.rejects(new D1Skills(fault(db,c2),f.scope).checkpoint(request),{code:'persistence_unknown'});
 const receipt=await f.skills.checkpoint(request);assert.equal(receipt.record_id,(await f.skills.taskSkills(f.run.id)).items[0].record_id);});
 await t.test('closed tasks, malformed manifests, arbitrary paths and oversized writes never claim success',async()=>{const f=await seed();await f.skills.register(reg(f));const a=await f.skills.assign(assign());putPackage(reg(f));
 for(const files of [[],[{path:'SKILL.md',state:'matches',hash:hash('wrong'),bytes:1}],[{path:'SKILL.md',state:'missing',hash:hash('bad'),bytes:1}]])
 await assert.rejects(new D1Skills(db,f.scope,{root_hash:f.scope.root_hash,async observe(){return files;}}).inspect({installation_id:a.installation_id,idempotency_key:randomUUID()}),{code:'invalid_data'});
 await assert.rejects(f.skills.register(reg(f,{files:[{path:'../secret.txt',content:'blocked'}]})),{code:'invalid_input'});
 const before=await snapshot();await assert.rejects(f.skills.register(reg(f,{skill_key:'large',body:'한'.repeat(24000)})),{code:'resource_limit'});assert.equal(await snapshot(),before);
 await f.store.commit(await mutation(f,{run:{...f.run,state:'completed'}}));await assert.rejects(f.skills.checkpoint(report(f)),{code:'run_closed'});
 await assert.rejects(f.skills.list('',-1),{code:'invalid_input'});await assert.rejects(f.skills.taskSkills(f.run.id,100001),{code:'invalid_input'});
 });
 await t.test('paged reports/installations/catalogs and append-only SQL preserve explicit histories',async()=>{const f=await seed();await f.skills.register(reg(f));for(let n=0;n<11;n++)await f.skills.register(reg(f,{skill_key:'page-'+n}));
 let p=await f.skills.list(),q=await f.skills.list('',p.next_offset);assert.equal(p.items.length+q.items.length,12);assert.equal(p.items[0].skill_key,'page-10');
 for(let n=0;n<8;n++)await f.skills.assign(assign({folder:'slot-'+n}));p=await f.skills.detail('review-guide','1');q=await f.skills.detail('review-guide','1',p.next_installation_offset);assert.equal(p.installations.length+q.installations.length,8);
 for(let n=0;n<10;n++)await f.skills.checkpoint(report(f));p=await f.skills.taskSkills(f.run.id);q=await f.skills.taskSkills(f.run.id,p.next_offset);assert.equal(p.items.length+q.items.length,10);
 for(const table of ['skill_versions','skill_installations','skill_assignments','task_skill_usage']){await assert.rejects(db.prepare(`UPDATE ${table} SET project_id=project_id WHERE project_id=?`).bind(f.p.id).run());await assert.rejects(db.prepare(`DELETE FROM ${table} WHERE project_id=?`).bind(f.p.id).run());}
 });
 await t.test('workerd restart and fresh binding re-read the same full package, original observation and use report',async()=>{const {f,i,o}=observed,before=await f.skills.taskSkills(f.run.id);await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');
 const next=await worker({operation:'task-skills',scope:f.scope,run_id:f.run.id});assert.deepEqual(next,before);assert.ok(next.items.some(x=>x.file_observation?.id===o.observation_id));
 const pkg=await worker({operation:'skill-package',scope:f.scope,key:i.skill_key,version:'1'});assert.equal(parseSkillPackage(pkg).body,i.body);
 const fresh=new D1Skills(db,f.scope);assert.deepEqual(await fresh.taskSkills(f.run.id),before);assert.equal((await fresh.detail('review-guide','2')).installations[0].version,'2');});
});
