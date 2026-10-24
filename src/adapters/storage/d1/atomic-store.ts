import { validateMutationOwnership, type AtomicCommitStore } from "../../../core/memory/atomic-commit.js";
import { MemoryError, parseJsonObject, type Receipt } from "../../../core/memory/model.js";
import type { D1Binding, D1Statement } from "./binding.js";
import { appendD1Work, validateD1Work } from "./work.js";
import { prepareD1Decision } from "./decisions.js";
import { prepareD1Plan, type D1Mutation } from "./plan-mutation.js";
import { prepareD1Execution } from "./execution-mutation.js";
import { prepareD1Skill } from "./skill-mutation.js";
import { prepareD1Event } from "./event-mutation.js";

export const D1_WRITE_LIMITS = Object.freeze({ mutation_bytes: 64 * 1024, receipt_bytes: 16 * 1024, records: 8, statements: 40 });
const encoder = new TextEncoder();

/** First cloud seam only: not a full MemoryStore, HTTP endpoint, authenticator or transfer target. */
export class D1AtomicCommitStore implements AtomicCommitStore {
  constructor(private readonly binding: D1Binding, private readonly projectId: string) {
    if (!projectId || projectId.length > 100) throw new MemoryError("invalid_input", "Bind storage to an explicit project.");
  }

  private scope(scope: string): void {
    if (scope !== this.projectId) throw new MemoryError("scope_mismatch", "This storage binding cannot access another project.");
  }

  async getReceipt(scope: string, key: string): Promise<Receipt | undefined> {
    return (await this.savedReceipt(scope, key))?.receipt;
  }

  private async savedReceipt(scope: string, key: string): Promise<{ receipt: Receipt; token: string } | undefined> {
    this.scope(scope);
    // A fresh receipt lookup must not return an old replica's absence after a lost response.
    const response = await this.binding.withSession("first-primary")
      .prepare("SELECT payload_hash, result_json, commit_token FROM receipts WHERE scope=? AND idempotency_key=?")
      .bind(scope, key).all();
    if (!response.success || !Array.isArray(response.results) || response.results.length > 1) {
      throw new MemoryError("storage_error", "Receipt lookup did not return a valid result.");
    }
    const row = response.results[0];
    if (!row) return undefined;
    if (typeof row["payload_hash"] !== "string" || typeof row["result_json"] !== "string" || typeof row["commit_token"] !== "string") {
      throw new MemoryError("invalid_data", "Invalid saved receipt.");
    }
    if (encoder.encode(row["result_json"]).byteLength > D1_WRITE_LIMITS.receipt_bytes) {
      throw new MemoryError("resource_limit", "Saved receipt exceeds this binding's limit.");
    }
    return { receipt: { scope, key, hash: row["payload_hash"], result: parseJsonObject(row["result_json"]) }, token: row["commit_token"] };
  }

  async commit(change: D1Mutation): Promise<"committed" | "conflict"> {
    this.scope(change.project.id);
    this.scope(change.receipt.scope);
    validateMutationOwnership(change);
    // Explicitly fail before I/O: these require their own atomic D1 implementations.
    const allowed = new Set(["project", "expected_revision", "receipt", "run", "record", "records", "work", "reports", "decision", "plan", "execution", "lifecycle", "skill"]);
    if (Object.keys(change).some(key => !allowed.has(key))) {
      throw new MemoryError("unsupported_capability", "This D1 slice does not store imported history.");
    }
    const work = validateD1Work(change);
    const records = [...(change.record ? [change.record] : []), ...(change.records ?? [])];
    if (records.some(record => record.superseded_by !== null)) {
      throw new MemoryError("unsupported_capability", "Historical import links require a separate validated import contract.");
    }
    const receiptJson = JSON.stringify(change.receipt.result);
    if (records.length > D1_WRITE_LIMITS.records || encoder.encode(JSON.stringify(change)).byteLength > D1_WRITE_LIMITS.mutation_bytes
      || encoder.encode(receiptJson).byteLength > D1_WRITE_LIMITS.receipt_bytes) {
      throw new MemoryError("resource_limit", "Mutation exceeds the bounded D1 write contract. Nothing was submitted.");
    }
    const decision=await prepareD1Decision(this.binding,change);
    if(decision==="conflict")return "conflict";
    const plan=await prepareD1Plan(this.binding,change);
    if(plan==="conflict")return "conflict";
    const execution=await prepareD1Execution(this.binding,change);
    if(execution==="conflict")return "conflict";
    const lifecycle=await prepareD1Event(this.binding,change);
    if(lifecycle==="conflict")return "conflict";

    const skill=await prepareD1Skill(this.binding,change);
    if(skill==="conflict")return "conflict";

    const token = crypto.randomUUID();
    const session = this.binding.withSession("first-primary"), statements: D1Statement[] = [];
    const sql = (text: string, ...values: (string | number | null)[]) => statements.push(session.prepare(text).bind(...values));
    const assertOneChange = () => {
      // UPDATE zero rows is successful SQL. Turn it into a constraint failure INSIDE the batch.
      sql("INSERT INTO skilly_write_assertions (id, ok) VALUES (1, CASE WHEN changes()=1 THEN 1 ELSE 0 END)");
      sql("DELETE FROM skilly_write_assertions WHERE id=1");
    };
    const p = change.project;
    if (change.expected_revision === null) {
      sql(`INSERT INTO projects (id,project_key,name,revision,created_at)
        SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id=? OR project_key=?)`,
      p.id, p.key, p.name, p.revision, p.created_at, p.id, p.key);
    } else {
      sql("UPDATE projects SET revision=? WHERE id=? AND revision=? AND project_key=? AND created_at=?",
        p.revision, p.id, change.expected_revision, p.key, p.created_at);
    }
    assertOneChange();
    if (change.run) {
      const r = change.run;
      sql(`INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at
        WHERE runs.project_id=excluded.project_id AND runs.repository=excluded.repository AND runs.environment=excluded.environment`,
      r.id, r.project_id, r.goal, r.mode, r.environment, r.repository, r.state, r.created_at, r.updated_at);
      assertOneChange();
      if (r.actor) sql("INSERT INTO run_actors VALUES (?,?) ON CONFLICT(run_id) DO NOTHING", r.id, r.actor);
    }
    for (const r of records) {
      sql(`INSERT INTO records
        (id,project_id,run_id,topic,kind,body,environment,repository,source_fingerprint,observed_at,recorded_at,supersedes,superseded_by,report_origin)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS
          (SELECT 1 FROM runs WHERE project_id=? AND id=? AND repository=? AND environment=?)`,
      r.id, r.project_id, r.run_id, r.topic, r.kind, r.body, r.environment,
      r.repository, r.source_fingerprint, r.observed_at, r.recorded_at, r.supersedes, r.superseded_by, r.report_origin,
      p.id, r.run_id, r.repository, r.environment);
      assertOneChange();
      if (r.supersedes) {
        sql(`UPDATE records SET superseded_by=? WHERE project_id=? AND id=? AND superseded_by IS NULL
          AND topic=? AND kind=? AND repository=? AND environment=? AND observed_at<=?`,
        r.id, p.id, r.supersedes, r.topic, r.kind, r.repository, r.environment, r.observed_at);
        assertOneChange();
      }
    }
    for (const entry of work) appendD1Work(p.id, entry, sql, assertOneChange);
    decision?.(sql,assertOneChange);
    plan?.(sql,assertOneChange);
    execution?.(sql,assertOneChange);
    lifecycle?.(sql,assertOneChange);
    skill?.(sql,assertOneChange);
    sql("INSERT INTO receipts (scope,idempotency_key,payload_hash,result_json,commit_token) VALUES (?,?,?,?,?)",
      change.receipt.scope, change.receipt.key, change.receipt.hash, receiptJson, token);
    if (statements.length > D1_WRITE_LIMITS.statements) throw new MemoryError("resource_limit", "Too many statements. Nothing was submitted.");
    try {
      const result = await session.batch(statements);
      if (!Array.isArray(result) || result.length !== statements.length || result.some(row => !row || row.success !== true)
        || result[0]?.meta?.changes !== 1 || result.at(-1)?.meta?.changes !== 1) {
        throw new MemoryError("persistence_unknown", "Write response is incomplete. Recheck the same receipt; do not claim it was queued or lost.", true);
      }
      return "committed";
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      // Only our named in-batch assertion proves a clean CAS rejection.
      if (error instanceof Error && error.message.includes("CHECK constraint failed: skilly_atomic_change")) return "conflict";
      // A receipt UNIQUE race, or a committed response lost in transit, is resolved at the primary.
      const saved = await this.savedReceipt(change.receipt.scope, change.receipt.key).catch(() => undefined);
      // Equal payload/result alone could be an older receipt after THIS batch rolled back.
      if (saved) return saved.token === token ? "committed" : "conflict";
      throw new MemoryError("persistence_unknown", "No successful receipt was confirmed. Retry only the original request and key.", true);
    }
  }
}
