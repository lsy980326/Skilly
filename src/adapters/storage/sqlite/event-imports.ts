import type { DatabaseSync } from "node:sqlite";

/** Imported observations are history, never a current session anchor or active binding. */
export const eventImportSchemaSql = `CREATE TABLE IF NOT EXISTS event_imports (
  kind TEXT NOT NULL CHECK(kind IN ('event','link')), id TEXT NOT NULL,
  source_seq INTEGER NOT NULL, source_from_seq INTEGER, source_bundle_hash TEXT NOT NULL,
  PRIMARY KEY(kind,id)) STRICT;`;
export function hasEventImports(db: DatabaseSync) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='event_imports'").get());
}
export function nativeOnly(db: DatabaseSync, kind: "event" | "link", column: string) {
  return hasEventImports(db) ? ` AND NOT EXISTS(SELECT 1 FROM event_imports imported WHERE imported.kind='${kind}' AND imported.id=${column})` : "";
}
