import { MemoryError, type JsonObject, type Mutation, type Receipt } from "./model.js";

/** A conflict commits nothing. A thrown transport error may have lost a committed response. */
export interface AtomicCommitStore {
  getReceipt(scope: string, key: string): Promise<Receipt | undefined>;
  commit(mutation: Mutation): Promise<"committed" | "conflict">;
}

export type PreparedChange = Omit<Mutation, "receipt"> & { result: JsonObject };

/** Rebuild against current state after CAS conflict; preserve the original request identity. */
export async function commitWithReceipt(
  store: AtomicCommitStore, scope: string, key: string, hash: string,
  build: () => Promise<PreparedChange>,
): Promise<JsonObject> {
  const replay = (receipt: Receipt): JsonObject => {
    if (receipt.hash !== hash) throw new MemoryError("idempotency_conflict", "This key was already used with different input.");
    return receipt.result;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await store.getReceipt(scope, key);
    if (existing) return replay(existing);
    let next: PreparedChange;
    try { next = await build(); }
    catch (error) {
      // Another session can close the run between our receipt read and state checks.
      const raced = await store.getReceipt(scope, key);
      if (raced) return replay(raced);
      throw error;
    }
    const { result, ...change } = next;
    if (await store.commit({ ...change, receipt: { scope, key, hash, result } }) === "committed") return result;
  }
  throw new MemoryError("conflict", "Concurrent changes prevented this write. Retry with the same idempotency key.", true);
}

/** Domain-prepared mutations are still checked at the storage seam for ownership mistakes. */
export function validateMutationOwnership(change: Mutation): void {
  const p = change.project;
  if (!Number.isSafeInteger(p.revision) || p.revision < 0
    || (change.expected_revision === null ? p.revision !== 0
      : !Number.isSafeInteger(change.expected_revision) || change.expected_revision < 0 || p.revision !== change.expected_revision + 1)) {
    throw new MemoryError("invalid_input", "A mutation must create revision zero or increment the expected revision once.");
  }
  const records = [...(change.record ? [change.record] : []), ...(change.records ?? [])];
  const registration = change.receipt.scope === "registration" && !change.run && !records.length
    && !change.work && !change.reports && !change.decision && !change.skill_usage;
  if (change.receipt.scope !== p.id && !registration) throw new MemoryError("scope_mismatch", "Receipt scope must identify the mutation's project.");
  if (change.run && change.run.project_id !== p.id) throw new MemoryError("scope_mismatch", "Run belongs to a different project.");
  for (const r of records) {
    if (r.project_id !== p.id || (change.run && (r.run_id !== change.run.id
      || r.repository !== change.run.repository || r.environment !== change.run.environment))) {
      throw new MemoryError("scope_mismatch", "Record and run must belong to the same project and scope.");
    }
  }
}
