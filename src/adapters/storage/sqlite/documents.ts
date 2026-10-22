import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { reportSchema } from '../../../core/work/schema.js';
import { ViewerError } from '../../../core/viewer/model.js';

type Row = Record<string, SQLOutputValue>;
const PAGE = 20;
const base = `SELECT r.id,r.run_id,r.seq,r.repository,r.environment,r.recorded_at,
 json_extract(p.report_json,'$.import_source.path') path,
 json_extract(p.report_json,'$.import_source.source_root') source_root,
 json_extract(p.report_json,'$.import_source.sha256') sha256,
 json_extract(p.report_json,'$.import_source.bytes') bytes
 FROM records r JOIN record_reports p ON p.project_id=r.project_id AND p.record_id=r.id
 WHERE r.project_id=? AND r.topic='document-import' AND json_extract(p.report_json,'$.import_source.part')=1`;
const scopeFilter = 'repository=? AND environment=? AND path=? AND source_root=?';
function text(row: Row, key: string) { const value=row[key]; if(typeof value!=='string') throw new ViewerError('unavailable','문서 출처를 읽지 못했습니다.'); return value; }
function identifier(id: string) { if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new ViewerError('invalid_input','문서 식별자를 확인해 주세요.'); return id; }
function position(offset: number) { if(!Number.isSafeInteger(offset)||offset<0||offset>1000000) throw new ViewerError('invalid_input','목록 위치를 확인해 주세요.'); return offset; }
function scope(row: Row) { return ['repository','environment','path','source_root'].map(key=>text(row,key)); }
function metadata(row: Row) {
 return { id:text(row,'id'),run_id:text(row,'run_id'),repository:text(row,'repository'),environment:text(row,'environment'),path:text(row,'path'),source_root:text(row,'source_root'),
  sha256:text(row,'sha256'),bytes:row['bytes'],imported_at:text(row,'recorded_at'),report_origin:'retrospective',claims_verified:false,source_path_verified:false };
}

/** Read-only imported-source projection. It never reads source paths or promotes old claims. */
export class SqliteDocuments {
 constructor(private readonly db: DatabaseSync) {}
 list(projectId: string, offset=0, query='') {
  position(offset); if(query.length>200) throw new ViewerError('invalid_input','검색어는 200자 이하로 입력해 주세요.');
  const rows=this.db.prepare(`WITH versions AS (${base}), families AS (
   SELECT *,count(*) OVER(PARTITION BY repository,environment,path,source_root) version_count,
   row_number() OVER(PARTITION BY repository,environment,path,source_root ORDER BY seq DESC) rank FROM versions)
   SELECT * FROM families WHERE rank=1 AND instr(lower(path||' '||repository||' '||environment||' '||source_root),lower(?))>0
   ORDER BY seq DESC LIMIT ? OFFSET ?`).all(projectId,query.trim(),PAGE+1,offset);
  return {items:rows.slice(0,PAGE).map(row=>({...metadata(row),version_count:row['version_count']})),next_offset:rows.length>PAGE?offset+PAGE:null};
 }
 detail(projectId: string, id: string, options: {version?:string;compare?:string;offset?:number}={}) {
  const anchor=this.db.prepare(`SELECT * FROM (${base}) WHERE id=?`).get(projectId,identifier(id));
  if(!anchor) throw new ViewerError('not_found','이 프로젝트의 가져온 문서를 찾지 못했습니다.');
  const args=[projectId,...scope(anchor)],offset=position(options.offset??0);
  const family=`SELECT * FROM (${base}) WHERE ${scopeFilter}`;
  const rows=this.db.prepare(family+' ORDER BY seq DESC LIMIT ? OFFSET ?').all(...args,PAGE+1,offset);
  const find=(version:string)=>{
   const row=this.db.prepare(family+' AND id=?').get(...args,identifier(version));
   if(!row) throw new ViewerError('not_found','같은 문서 출처의 버전만 비교할 수 있습니다.');return row;
  };
  const current=options.version?find(options.version):this.db.prepare(family+' ORDER BY seq DESC LIMIT 1').get(...args)!;
  const previous=options.compare?this.db.prepare(`SELECT * FROM (${base}) WHERE id=?`).get(projectId,identifier(options.compare)):this.db.prepare(family+' AND seq<? ORDER BY seq DESC LIMIT 1').get(...args,current['seq']!);
  if(options.compare&&!previous) throw new ViewerError('not_found','이 프로젝트의 비교 문서를 찾지 못했습니다.');
  const total=this.db.prepare('SELECT count(*) n FROM ('+family+')').get(...args)?.['n'];
  return {document:metadata(anchor),versions:{items:rows.slice(0,PAGE).map(metadata),total,next_offset:rows.length>PAGE?offset+PAGE:null},
   current:this.original(projectId,current),previous:previous?this.original(projectId,previous):null,
   comparison_kind:previous?(JSON.stringify(scope(previous))===JSON.stringify(scope(current))?'same_document':'different_source_or_document'):null,
   warning:'모든 버전은 소급·미검증 자료입니다. 보관 순서는 원본 작성 순서나 현재 사실을 뜻하지 않습니다.'};
 }
 private original(projectId: string, row: Row) {
  const parts=this.db.prepare(`SELECT r.id,r.body,r.report_origin,p.report_json FROM records r JOIN record_reports p ON p.project_id=r.project_id AND p.record_id=r.id
   WHERE r.project_id=? AND r.run_id=? AND r.topic='document-import' AND r.repository=? AND r.environment=?
   AND json_extract(p.report_json,'$.import_source.path')=? AND json_extract(p.report_json,'$.import_source.source_root')=?
   AND json_extract(p.report_json,'$.import_source.sha256')=? ORDER BY json_extract(p.report_json,'$.import_source.part') LIMIT 10`)
   .all(projectId,text(row,'run_id'),...scope(row),text(row,'sha256'));
  let body='',expected=0;
  parts.forEach((part,index)=>{
   const report=reportSchema.safeParse(JSON.parse(text(part,'report_json'))),source=report.success?report.data.import_source:undefined;
   if(!source||source.part!==index+1||source.parts!==parts.length||source.bytes!==row['bytes']||part['report_origin']!=='retrospective')
    throw new ViewerError('unavailable','원문 조각이 누락되거나 출처가 일치하지 않아 표시하지 않았습니다.');
   expected=source.bytes;body+=text(part,'body');
  });
  if(!parts.length||Buffer.byteLength(body)!==expected||createHash('sha256').update(body).digest('hex')!==row['sha256'])
   throw new ViewerError('unavailable','저장된 원문과 내용 해시가 일치하지 않아 표시하지 않았습니다.');
  return {...metadata(row),text:body,record_ids:parts.map(part=>text(part,'id')),integrity:'stored_bytes_match_metadata'};
 }
}
