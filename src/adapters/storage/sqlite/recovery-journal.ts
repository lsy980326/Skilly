import { recoverySchemaSql } from "./recovery-schema.js";
import { closeSync, constants, existsSync, lstatSync, openSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { MemoryError, parseJsonObject } from "../../../core/memory/model.js";
import { isRecoverableWrite, type PendingWrite, type RecoveryJournal, type RecoveryScope } from "../../../core/memory/recovery.js";

const APPLICATION_ID = 1397446994;
const MAX_PENDING = 100;
const MAX_PENDING_BYTES = 1024 * 1024;

/** Open only on demand. No polling, background replay or connection to the network. */
export class SqliteRecoveryJournal implements RecoveryJournal {
  private db: DatabaseSync | undefined;
  constructor(private readonly path: string) {}

  close(): void { this.db?.close(); this.db = undefined; }

  private open(create: boolean): DatabaseSync | undefined {
    if (this.db) return this.db;
    if (!create && !existsSync(this.path)) return undefined;
    if (create) {
      try { closeSync(openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
          throw new MemoryError("recovery_unavailable", "Could not retain this request. No record write was attempted.");
        }
      }
    }
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new MemoryError("recovery_unavailable", "Recovery journal must be a regular file.");
    }
    const db = new DatabaseSync(this.path, { enableDoubleQuotedStringLiterals: false });
    try {
      db.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; PRAGMA cache_size = -1024;");
      const existingApp = db.prepare("PRAGMA application_id").get()?.["application_id"];
      const existingVersion = db.prepare("PRAGMA user_version").get()?.["user_version"];
      if (existingApp === APPLICATION_ID && existingVersion === 1) {
        this.db = db;
        return db;
      }
      if (!create) throw new MemoryError("recovery_unavailable", "Unsupported recovery journal; existing data was preserved.");
      db.exec("BEGIN IMMEDIATE");
      try {
        const app = db.prepare("PRAGMA application_id").get()?.["application_id"];
        const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
        if (app === 0 && version === 0 && db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.["n"] === 0 && create) {
          db.exec(recoverySchemaSql);
        } else if (app !== APPLICATION_ID || version !== 1) {
          throw new MemoryError("recovery_unavailable", "Unsupported recovery journal; existing data was preserved.");
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      if (error instanceof MemoryError) throw error;
      throw new MemoryError("recovery_unavailable", "Recovery journal is unavailable; retention is not confirmed.", true);
    }
  }

  async prepare(request: PendingWrite): Promise<"new" | "existing"> {
    const db = this.open(true);
    if (!db) throw new MemoryError("recovery_unavailable", "Recovery journal is unavailable.");
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(request.id);
        if (row) {
          const existing = fromRow(row);
          if (existing.hash !== request.hash || existing.tool !== request.tool
            || existing.project_id !== request.project_id || existing.repository !== request.repository
            || existing.environment !== request.environment || existing.key !== request.key) {
            throw new MemoryError("idempotency_conflict", "A retained request already uses this key with different input.");
          }
          // An acknowledged request cannot be silently recreated if its main receipt vanished.
          if (existing.input === null) throw new MemoryError(existing.last_error ? "request_rejected" : "receipt_missing",
            existing.last_error ? "This request was rejected; use a new key for a new corrected request."
              : "A previously acknowledged request has no record receipt; investigate before recovery.");
          // Another attempt may still be running. A newly rejected caller must not erase its input.
          db.prepare("UPDATE requests SET preserve_input = 1 WHERE id = ?").run(request.id);
        } else {
          const json = JSON.stringify(request.input);
          const total = db.prepare("SELECT count(*) AS n, coalesce(sum(length(CAST(input_json AS BLOB))), 0) AS bytes FROM requests WHERE input_json IS NOT NULL").get();
          if (Number(total?.["n"]) >= MAX_PENDING || Number(total?.["bytes"]) + Buffer.byteLength(json) > MAX_PENDING_BYTES) {
            throw new MemoryError("recovery_full", "Recovery queue is full; no request was dropped and no record write was attempted.");
          }
          db.prepare(`INSERT INTO requests
            (id, project_id, repository, environment, tool, request_key, payload_hash, input_json, received_at, last_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(request.id, request.project_id, request.repository, request.environment, request.tool,
              request.key, request.hash, json, request.received_at, null);
        }
        db.exec("COMMIT");
        return row ? "existing" : "new";
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError("recovery_unavailable", "Could not retain the request. No record write was attempted.", true);
    }
  }

  async get(id: string): Promise<PendingWrite | undefined> {
    const row = this.open(false)?.prepare("SELECT * FROM requests WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }

  async list(scope: RecoveryScope, limit: number, offset: number): Promise<PendingWrite[]> {
    return this.open(false)?.prepare(`SELECT * FROM requests
      WHERE project_id = ? AND repository = ? AND environment = ? AND input_json IS NOT NULL
      ORDER BY received_at, id LIMIT ? OFFSET ?`)
      .all(scope.project_id, scope.repository, scope.environment, limit, offset).map(fromRow) ?? [];
  }

  async markSaved(id: string): Promise<boolean> {
    // Only the redundant queue payload is released; report and receipt stay in the primary DB.
    return (this.open(false)?.prepare("UPDATE requests SET input_json = NULL, last_error = NULL WHERE id = ?").run(id).changes ?? 0) > 0;
  }

  async markFailed(id: string, code: string, retainInput: boolean): Promise<boolean> {
    // Evaluate against current journal state, not a caller's old prepare result.
    const row = this.open(false)?.prepare(`UPDATE requests
      SET last_error = ?, input_json = CASE WHEN ? OR preserve_input = 1 OR last_error IS NOT NULL THEN input_json ELSE NULL END,
        preserve_input = CASE WHEN ? THEN 1 ELSE preserve_input END
      WHERE id = ? AND input_json IS NOT NULL RETURNING input_json IS NOT NULL AS retained`)
      .get(code, retainInput ? 1 : 0, retainInput ? 1 : 0, id);
    return row?.["retained"] === 1;
  }
}

function fromRow(row: Record<string, SQLOutputValue>): PendingWrite {
  const text = (key: string) => {
    const value = row[key];
    if (typeof value !== "string") throw new MemoryError("invalid_data", `Invalid recovery field: ${key}.`);
    return value;
  };
  const tool = text("tool");
  if (!isRecoverableWrite(tool)) throw new MemoryError("invalid_data", "Invalid recovery tool.");
  return {
    id: text("id"), project_id: text("project_id"), repository: text("repository"), environment: text("environment"),
    tool, key: text("request_key"), hash: text("payload_hash"),
    input: row["input_json"] === null ? null : parseJsonObject(text("input_json")),
    received_at: text("received_at"), last_error: row["last_error"] === null ? null : text("last_error"),
  };
}
