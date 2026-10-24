import { z } from "zod";
import { MemoryError, type JsonObject, type Project } from "../../../core/memory/model.js";
import { commitWithReceipt } from "../../../core/memory/atomic-commit.js";
import { markdownItems, planProgress } from "../../../core/plans/model.js";
import { D1AtomicCommitStore } from "./atomic-store.js";
import { d1SavePlanSchema, d1UpdatePlanSchema, type D1PlanChange } from "./plan-mutation.js";
import { D1PlanReader } from "./plan-reader.js";
import { canonical, hashText, json, rows, scope, type D1Scope } from "./query.js";
import type { D1Binding } from "./binding.js";

/** Host-scoped plan commands. No filesystem reads, automatic queue or live-DB wiring. */
export class D1Plans extends D1PlanReader {
  private readonly writeScope:D1Scope;
  private readonly store:D1AtomicCommitStore;
  constructor(private readonly binding:D1Binding,s:D1Scope){super(binding,s);this.writeScope=scope(s);this.store=new D1AtomicCommitStore(binding,s.project_id);}
  private async write(c:D1PlanChange,result:JsonObject):Promise<JsonObject> {
    const s=this.writeScope,digest=await hashText(canonical({operation:c.operation,input:c.input}));
    return commitWithReceipt(this.store,s.project_id,c.input.idempotency_key,digest,async()=>{
      const [p]=await rows(this.binding,"SELECT id,project_key AS key,name,revision,created_at FROM projects WHERE id=?",[s.project_id],1);
      if(!p)throw new MemoryError("not_found","Project not found.");
      const schema=z.strictObject({id:z.uuid(),key:z.string(),name:z.string(),revision:z.int().nonnegative(),created_at:z.string()});
      const project:Project=schema.parse(p);
      return {project:{...project,revision:project.revision+1},expected_revision:project.revision,plan:c,result};
    });
  }
  async save(input:z.input<typeof d1SavePlanSchema>):Promise<JsonObject> {
    const parsed=d1SavePlanSchema.safeParse(input);
    if(!parsed.success)throw new MemoryError("invalid_input","Invalid plan source or conditions.");
    const i=parsed.data,items=i.items??(i.source_kind==="markdown"?markdownItems(i.source_body):undefined);
    if(!items)throw new MemoryError("invalid_input","Conversation plans require explicit items.");
    const result={status:"persisted",plan_key:i.plan_key,version:i.expected_version+1,source_hash:await hashText(i.source_body),item_count:items.length,
      progress:json(planProgress(items.map(x=>({...x,state:"pending"})))),source_path_verified:false,claims_verified:false,recovery_queued:false};
    return this.write({operation:"save",input:{...i,...this.writeScope},created_at:new Date().toISOString()},result);
  }
  async update(input:z.input<typeof d1UpdatePlanSchema>):Promise<JsonObject> {
    const parsed=d1UpdatePlanSchema.safeParse(input);
    if(!parsed.success)throw new MemoryError("invalid_input","Invalid plan progress request.");
    const i=parsed.data;
    if(i.execution_ids.length)throw new MemoryError("unsupported_capability","D1 execution links are not supported yet.");
    const id=crypto.randomUUID();
    return this.write({operation:"update",input:{...i,...this.writeScope},id,created_at:new Date().toISOString()},
      {status:"persisted",update_id:id,plan_key:i.plan_key,version:i.version,item_key:i.item_key,state:i.state,claims_verified:false,recovery_queued:false});
  }
}
