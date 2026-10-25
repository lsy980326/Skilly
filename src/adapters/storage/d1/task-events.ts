import { nativeOnly } from "./authority.js";
import { z } from "zod";
import { MemoryError,type Project,type JsonObject } from "../../../core/memory/model.js";
import { commitWithReceipt } from "../../../core/memory/atomic-commit.js";
import { D1AtomicCommitStore } from "./atomic-store.js";
import { D1EventReader } from "./event-reader.js";
import { receiveEventSchema,linkEventSchema,type D1EventChange,type D1EventScope } from "./event-model.js";
import { rows,hashText,canonical } from "./query.js";
import type { D1Binding } from "./binding.js";
import { hasEventSchema } from "./event-mutation.js";

/** Host-internal normalized event sink, not a new hook installation, AI write tool or network client. */
export class D1TaskEvents extends D1EventReader {
  private readonly store:D1AtomicCommitStore;
  constructor(db:D1Binding,s:D1EventScope){super(db,s);this.store=new D1AtomicCommitStore(db,s.project_id);}
  private async write(operation:"receive"|"link",input:z.output<typeof receiveEventSchema>|z.output<typeof linkEventSchema>) {
    const s=this.scope,digest=await hashText(canonical({operation,input,scope:s}));
    return commitWithReceipt(this.store,s.project_id,input.idempotency_key,digest,async()=>{
      // Revision is read BEFORE domain preparation and is never replaced with a newer revision.
      const [p]=await rows(this.db,"SELECT id,project_key AS key,name,revision,created_at FROM projects WHERE id=?",[s.project_id],1);
      if(!p)throw new MemoryError("not_found","Project not found.");
      const project:Project=z.strictObject({id:z.uuid(),key:z.string(),name:z.string(),revision:z.int().nonnegative(),created_at:z.string()}).parse(p);
      let lifecycle:D1EventChange,result:JsonObject;
      if(operation==="receive") {
        const i=receiveEventSchema.parse(input);
        lifecycle={operation,input:{...i,...s},at:new Date().toISOString()};
        result={observation_id:i.observation_id,delivery_status:"saved",work_record_saved:false,provenance:"local_hook_input",claims_verified:false,recovery_queued:false};
      }else {
        const i=linkEventSchema.parse(input);
        // Older schemas still return an explicit capability error from preparation.
        const prior=await hasEventSchema(this.db)?await rows(this.db,`SELECT id,run_id FROM task_event_links
          WHERE project_id=? AND repository=? AND environment=? AND root_hash=? AND session_hash=? AND ${await nativeOnly(this.db,"task_event_links","link")} ORDER BY seq DESC LIMIT 1`,
          [s.project_id,s.repository,s.environment,s.root_hash,s.session_hash],1):[];
        const id=prior[0]?.["run_id"]===i.run_id?String(prior[0]["id"]):crypto.randomUUID();
        lifecycle={operation,input:{...i,...s},id,at:new Date().toISOString()};
        result={status:"persisted",link_id:id,run_id:i.run_id,linkage:"explicit_agent_binding",claims_verified:false,recovery_queued:false};
      }
      return {project:{...project,revision:project.revision+1},expected_revision:project.revision,lifecycle,result};
    });
  }
  async receive(input:z.input<typeof receiveEventSchema>):Promise<JsonObject> {
    const parsed=receiveEventSchema.safeParse(input);if(!parsed.success)throw new MemoryError("invalid_input","Invalid normalized host event.");
    return this.write("receive",parsed.data);
  }
  async link(input:z.input<typeof linkEventSchema>):Promise<JsonObject> {
    const parsed=linkEventSchema.safeParse(input);if(!parsed.success)throw new MemoryError("invalid_input","Invalid explicit event/task link.");
    return this.write("link",parsed.data);
  }
}
