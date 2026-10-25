import { z } from "zod";
import { MemoryError, type JsonObject, type Project } from "../../../core/memory/model.js";
import { commitWithReceipt } from "../../../core/memory/atomic-commit.js";
import type { SourceProvider } from "../../../core/execution/currentness.js";
import { D1AtomicCommitStore } from "./atomic-store.js";
import { D1ExecutionReader } from "./execution-reader.js";
import { executionStartSchema, executionFinishSchema, type D1ExecutionChange } from "./execution-mutation.js";
import { canonical, hashText, json, rows, type D1Scope } from "./query.js";
import type { D1Binding } from "./binding.js";

/** Internal runner sink. Never expose these DTO writes as AI tools or call them authenticated facts. */
export class D1Executions extends D1ExecutionReader {
  private readonly store:D1AtomicCommitStore;
  constructor(db:D1Binding,s:D1Scope,sources?:SourceProvider){super(db,s,sources);this.store=new D1AtomicCommitStore(db,s.project_id);}
  private async write(c:D1ExecutionChange,result:JsonObject):Promise<JsonObject> {
    result={...result,scope:json(this.scope)};
    const digest=await hashText(canonical({operation:c.operation,input:c.input}));
    return commitWithReceipt(this.store,this.scope.project_id,c.input.idempotency_key,digest,async()=>{
      const [p]=await rows(this.db,"SELECT id,project_key AS key,name,revision,created_at FROM projects WHERE id=?",[this.scope.project_id],1);
      if(!p)throw new MemoryError("not_found","Project not found.");
      const project:Project=z.strictObject({id:z.uuid(),key:z.string(),name:z.string(),revision:z.int().nonnegative(),created_at:z.string()}).parse(p);
      return {project:{...project,revision:project.revision+1},expected_revision:project.revision,execution:c,result};
    });
  }
  async start(input:z.input<typeof executionStartSchema>):Promise<JsonObject> {
    return this.startWithId(input,crypto.randomUUID());
  }
  /** A replayed storage receipt must never authorize another process spawn. */
  async startForProcess(input:z.input<typeof executionStartSchema>):Promise<JsonObject> {
    const id=crypto.randomUUID(),result=await this.startWithId(input,id);
    if(canonical(result['scope'])!==canonical(this.scope))throw new MemoryError('scope_mismatch','Receipt scope differs.');
    if(result['execution_id']!==id)throw new MemoryError('execution_already_started','A start receipt already exists. Inspect it; never replay the command.',false,
      {execution_id:result['execution_id']!,automatic_replay:false});
    return result;
  }
  private async startWithId(input:z.input<typeof executionStartSchema>,id:string):Promise<JsonObject> {
    const parsed=executionStartSchema.safeParse(input);
    if(!parsed.success)throw new MemoryError("invalid_input","Invalid runner start request.");
    return this.write({operation:"start",input:{...parsed.data,...this.scope},id,at:new Date().toISOString()},
      {status:"persisted",execution_id:id,outcome:"unconfirmed",claims_verified:false,recovery_queued:false});
  }
  async finish(input:z.input<typeof executionFinishSchema>):Promise<JsonObject> {
    const parsed=executionFinishSchema.safeParse(input);
    if(!parsed.success)throw new MemoryError("invalid_input","Invalid runner finish request.");
    return this.write({operation:"finish",input:{...parsed.data,...this.scope},at:new Date().toISOString()},
      {status:"persisted",execution_id:parsed.data.execution_id,outcome:parsed.data.result.outcome,claims_verified:false,recovery_queued:false});
  }
}
