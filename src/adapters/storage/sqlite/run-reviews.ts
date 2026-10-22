import type { DatabaseSync } from "node:sqlite";
import { ViewerError } from "../../../core/viewer/model.js";

// Use the same snapshot predicate before pagination and for project counts.
export const unreviewedRunSql = `NOT EXISTS (SELECT 1 FROM run_acknowledgements ack
  WHERE ack.project_id=r.project_id AND ack.run_id=r.id AND ack.acknowledged_updated_at=r.updated_at)`;

/** A local user's read receipt is independent of the AI's work/validation reports. */
export class SqliteRunReviews {
  constructor(private readonly db: DatabaseSync) {}
  status(projectId: string, runId: string, updatedAt: string) {
    const supported = Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]) >= 9;
    const row = supported ? this.db.prepare(`SELECT acknowledged_at FROM run_acknowledgements
      WHERE project_id=? AND run_id=? AND acknowledged_updated_at=?`).get(projectId, runId, updatedAt) : undefined;
    return { state: row ? "acknowledged" : "unreviewed", acknowledged_at: row?.["acknowledged_at"] ?? null,
      scope: "local_database", meaning: "user_read_not_validation" };
  }
  acknowledge(projectId: string, runId: string, expectedUpdatedAt: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db.prepare("SELECT state,updated_at FROM runs WHERE project_id=? AND id=?").get(projectId, runId);
      if (!run) throw new ViewerError("not_found", "이 프로젝트의 작업을 찾지 못했습니다.");
      if (run["state"] !== "completed" || run["updated_at"] !== expectedUpdatedAt)
        throw new ViewerError("invalid_input", "작업 기록이 바뀌었습니다. 새로고침 후 완료 기록을 다시 확인해 주세요.");
      this.db.prepare(`INSERT INTO run_acknowledgements VALUES(?,?,?,?) ON CONFLICT DO NOTHING`)
        .run(projectId, runId, expectedUpdatedAt, new Date().toISOString());
      const result = this.status(projectId, runId, expectedUpdatedAt);
      this.db.exec("COMMIT");
      return { status: "persisted", project_id: projectId, run_id: runId, review: result, claims_verified: false };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
