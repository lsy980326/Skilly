import { MemoryError } from "../../../core/memory/model.js";
import { eventCommandSchema,lastSavedSql } from "./event-model.js";
import { rows,canonical,hashText,type Sql } from "./query.js";
import type { D1Binding } from "./binding.js";
import type { D1Mutation } from "./plan-mutation.js";

export async function hasEventSchema(db:D1Binding) {
  return (await rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='lifecycle_events'",[],1)).length===1;
}
export async function prepareD1Event(db:D1Binding,change:D1Mutation):Promise<((sql:Sql,assertOne:()=>void)=>void)|"conflict"|undefined> {
  if(change.lifecycle===undefined)return undefined;
  const parsed=eventCommandSchema.safeParse(change.lifecycle);
  if(!parsed.success)throw new MemoryError("invalid_input","Invalid host lifecycle command.");
  if(change.run||change.record||change.records||change.work||change.reports||change.decision||change.plan||change.execution)
    throw new MemoryError("invalid_input","Lifecycle metadata is separate from work and process reports.");
  const c=parsed.data,i=c.input;
  if(i.project_id!==change.project.id||i.idempotency_key!==change.receipt.key)throw new MemoryError("scope_mismatch","Lifecycle and receipt scope differ.");
  if(!await hasEventSchema(db))throw new MemoryError("unsupported_capability","Apply the explicit D1 event schema first.");
  const values=[i.project_id,i.repository,i.environment,i.root_hash,i.session_hash];
  if(c.operation==="receive") {
    const input=c.input,{idempotency_key:_key,...identity}=input,payloadHash=await hashText(canonical(identity));
    const [saved]=await rows(db,`SELECT p.revision,
      (SELECT payload_hash FROM lifecycle_events WHERE project_id=p.id AND id=?) AS prior_hash,
      (SELECT count(*) FROM lifecycle_events WHERE project_id=p.id) AS total,
      (SELECT id FROM task_event_links WHERE project_id=? AND repository=? AND environment=? AND root_hash=? AND session_hash=? ORDER BY seq DESC LIMIT 1) AS link_id
      FROM projects p WHERE id=?`,[input.observation_id,...values,i.project_id],1);
    if(!saved)throw new MemoryError("not_found","Project not found.");
    if(saved["revision"]!==change.expected_revision)return "conflict";
    if(saved["prior_hash"]!==null) {
      if(saved["prior_hash"]!==payloadHash)throw new MemoryError("event_conflict","The observation ID already identifies different original metadata.");
      return ()=>{}; // New delivery receipt only; never re-associate/backfill an existing observation.
    }
    if(Number(saved["total"])>=10000)throw new MemoryError("event_store_full","Event capacity reached; this event was not retained or queued.");
    return (sql,assertOne)=>{
      sql(`INSERT INTO lifecycle_events(id,project_id,project_key,repository,environment,root_hash,session_hash,turn_hash,event,source,tool_group,observed_at,received_at,payload_hash,association_status)
        SELECT ?,p.id,p.project_key,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN l.id IS NULL THEN 'not_linked' WHEN r.state='active' THEN 'linked' ELSE 'run_closed' END
        FROM projects p LEFT JOIN task_event_links l ON l.project_id=p.id AND l.id=?
        LEFT JOIN runs r ON r.project_id=l.project_id AND r.id=l.run_id AND r.repository=l.repository AND r.environment=l.environment WHERE p.id=?`,
        input.observation_id,i.repository,i.environment,i.root_hash,i.session_hash,input.turn_hash,input.event,input.source,input.tool_group,input.observed_at,c.at,payloadHash,saved["link_id"] as string|null,i.project_id);
      assertOne();
      if(saved["link_id"]!==null) {
        // A closed task is a received-but-unassociated event, not a failed association or work finish.
        sql(`INSERT INTO event_task_snapshots SELECT e.project_id,e.id,l.id,${lastSavedSql("e.project_id","l.run_id","e.received_at")}
          FROM lifecycle_events e JOIN task_event_links l ON l.project_id=e.project_id AND l.id=?
          JOIN runs r ON r.project_id=l.project_id AND r.id=l.run_id WHERE e.project_id=? AND e.id=?
          AND e.association_status='linked' AND r.state='active' AND e.seq>=l.from_seq`,
          saved["link_id"] as string,i.project_id,input.observation_id);
        sql(`INSERT INTO skilly_write_assertions(id,ok) VALUES(1,CASE WHEN changes()=
          (SELECT CASE WHEN association_status='linked' THEN 1 ELSE 0 END FROM lifecycle_events WHERE project_id=? AND id=?) THEN 1 ELSE 0 END)`,
          i.project_id,input.observation_id);
        sql("DELETE FROM skilly_write_assertions WHERE id=1");
      }
    };
  }
  const input=c.input;
  const [saved]=await rows(db,`SELECT p.revision,r.state,
    (SELECT seq FROM lifecycle_events WHERE project_id=p.id AND id=? AND repository=? AND environment=? AND root_hash=? AND session_hash=?) AS anchor_seq,
    (SELECT event FROM lifecycle_events WHERE project_id=p.id AND id=?) AS anchor_event,
    (SELECT count(*) FROM task_event_links WHERE project_id=p.id) AS total,
    (SELECT id FROM task_event_links WHERE project_id=? AND repository=? AND environment=? AND root_hash=? AND session_hash=? ORDER BY seq DESC LIMIT 1) AS prior_id,
    (SELECT run_id FROM task_event_links WHERE project_id=? AND repository=? AND environment=? AND root_hash=? AND session_hash=? ORDER BY seq DESC LIMIT 1) AS prior_run
    FROM projects p JOIN runs r ON r.project_id=p.id WHERE p.id=? AND r.id=? AND r.repository=? AND r.environment=?`,
    [input.observation_id,i.repository,i.environment,i.root_hash,i.session_hash,input.observation_id,...values,...values,i.project_id,input.run_id,i.repository,i.environment],1);
  if(!saved||saved["anchor_seq"]===null)throw new MemoryError("scope_mismatch","The explicit task and anchor must belong to this exact host session/root/scope.");
  if(saved["revision"]!==change.expected_revision)return "conflict";
  if(saved["prior_run"]===input.run_id) {
    if(saved["prior_id"]!==c.id)return "conflict";
    return ()=>{}; // Stable same-task link receipt; never replace the original watermark.
  }
  if(saved["state"]!=="active")throw new MemoryError("run_closed","Only an active saved task can establish a new link.");
  if(saved["prior_run"]!==null) {
    const old=await rows(db,"SELECT state FROM runs WHERE project_id=? AND id=?",[i.project_id,String(saved["prior_run"])],1);
    if(!old[0]||old[0]["state"]==="active")throw new MemoryError("link_conflict","Do not take over another unfinished task in this session.");
  }
  const boundary=await rows(db,`SELECT seq FROM lifecycle_events WHERE project_id=? AND repository=? AND environment=? AND root_hash=? AND session_hash=?
    AND seq>? AND event NOT IN ('PostToolUse','PreCompact') LIMIT 1`,[...values,Number(saved["anchor_seq"])],1);
  if(boundary.length||!["SessionStart","PostToolUse","PreCompact"].includes(String(saved["anchor_event"])))
    throw new MemoryError("stale_anchor","A stop, interruption or session restart invalidated this anchor.");
  if(Number(saved["total"])>=10000)throw new MemoryError("link_store_full","Link capacity reached; nothing was removed or queued.");
  return (sql,assertOne)=>{
    sql(`INSERT INTO task_event_links(id,project_id,run_id,repository,environment,root_hash,session_hash,anchor_id,from_seq,linked_at)
      SELECT ?,?,?,?,?,?,?,?,coalesce((SELECT max(seq) FROM lifecycle_events),0)+1,? WHERE EXISTS
      (SELECT 1 FROM runs WHERE project_id=? AND id=? AND repository=? AND environment=? AND state='active')`,
      c.id,i.project_id,input.run_id,i.repository,i.environment,i.root_hash,i.session_hash,input.observation_id,c.at,
      i.project_id,input.run_id,i.repository,i.environment);
    assertOne();
  };
}
