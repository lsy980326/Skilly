import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isRecoverableWrite } from "../../../core/memory/recovery.js";
import { fail } from "./files.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("invalid_bundle", "Unsupported recovery input.");
  return encoded;
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function validateRecoveryRow(row: Record<string, SQLOutputValue>): void {
  const tool = row["tool"];
  if (typeof tool !== "string" || !isRecoverableWrite(tool) || row["id"] !== hash([row["project_id"], row["request_key"]])) {
    fail("invalid_recovery", "Recovery identity does not match its project and key.");
  }
  if (row["input_json"] !== null) {
    let input;
    try { input = JSON.parse(String(row["input_json"])); } catch { fail("invalid_recovery", "Malformed retained request."); }
    const operations = { memory_begin_task: "begin", memory_checkpoint: "checkpoint", memory_finish_task: "finish" };
    if (!input || typeof input !== "object" || Array.isArray(input) || input.project_id !== row["project_id"]
      || input.idempotency_key !== row["request_key"] || hash({ operation: operations[tool], ...input }) !== row["payload_hash"]) {
      fail("invalid_recovery", "Retained request differs from its original hash and scope.");
    }
  }
}
export function validateRecoveryPair(main: DatabaseSync, journal: DatabaseSync, projectId?: string): void {
  const statement = journal.prepare(`SELECT * FROM requests${projectId ? " WHERE project_id = ?" : ""}`);
  for (const row of projectId ? statement.iterate(projectId) : statement.iterate()) {
    validateRecoveryRow(row);
    if (!main.prepare("SELECT id FROM projects WHERE id = ?").get(row["project_id"]!)) fail("invalid_recovery", "Recovery request has no owning project.");
    const receipt = main.prepare("SELECT payload_hash FROM receipts WHERE scope = ? AND idempotency_key = ?")
      .get(row["project_id"]!, row["request_key"]!);
    if (receipt && receipt["payload_hash"] !== row["payload_hash"]) fail("invalid_recovery", "Recovery and receipt hashes conflict.");
    if (!receipt && row["input_json"] === null && row["last_error"] === null) {
      fail("receipt_missing", "Acknowledged recovery request is missing its matching main receipt.");
    }
  }
}
