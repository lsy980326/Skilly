import type { DatabaseSync } from "node:sqlite";
import { fail } from "./files.js";

export type EventReceiptReferences = Map<string, { records: Set<string>; runs: Set<string> }>;

/** Keep only requested event references, not an in-memory copy of the receipt history. */
export function validateEventReceipts(main: DatabaseSync, required: EventReceiptReferences): void {
  if (!required.size) return;
  // IDs are UUID strings. Do not deserialize unrelated JSON integers into JS Numbers.
  const direct = main.prepare(`SELECT
    CASE WHEN json_type(result_json,'$.record_id')='text' THEN json_extract(result_json,'$.record_id') END AS record_id,
    CASE WHEN json_type(result_json,'$.run.id')='text' THEN json_extract(result_json,'$.run.id') END AS run_id
    FROM receipts WHERE scope=?`);
  const multiple = main.prepare(`SELECT j.value AS record_id FROM receipts q,
    json_each(q.result_json,'$.record_ids') j WHERE q.scope=? AND j.type='text'`);
  for (const [project, refs] of required) {
    for (const row of direct.iterate(project)) {
      if (typeof row["record_id"] === "string") refs.records.delete(row["record_id"]);
      if (typeof row["run_id"] === "string") refs.runs.delete(row["run_id"]);
      if (!refs.records.size && !refs.runs.size) break;
    }
    // Preserve SQLite json_each semantics for array, scalar and object legacy receipts.
    if (refs.records.size) for (const row of multiple.iterate(project)) {
      if (typeof row["record_id"] === "string") refs.records.delete(row["record_id"]);
      if (!refs.records.size) break;
    }
    if (refs.records.size || refs.runs.size) fail("invalid_event_link", "Saved-point receipt is missing from the main snapshot.");
  }
}
