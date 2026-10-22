import { validateSkillData } from "../sqlite/skills.js";
import { validateExecutionData } from "../sqlite/executions.js";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { recoverySchemaSql } from "../sqlite/recovery-schema.js";
import { fileDescriptor, fail } from "./files.js";
import { closeSync } from "node:fs";

export function initialize(db: DatabaseSync, recovery = false, version = 9): void {
  if (recovery) db.exec(recoverySchemaSql);
  else for (const name of ["001-local-memory", "002-recovery", "003-run-actors", "004-work-structure", ...(version >= 5 ? ["005-skill-library"] : []), ...(version >= 6 ? ["006-executions"] : []), ...(version >= 7 ? ["007-test-details"] : []), ...(version >= 8 ? ["008-execution-source"] : []), ...(version >= 9 ? ["009-run-acknowledgements"] : [])]) {
    db.exec(readFileSync(new URL(`../../../../migrations/${name}.sql`, import.meta.url), "utf8"));
  }
}
function schema(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all());
}
export function validateDatabase(db: DatabaseSync, recovery = false): void {
  const expected = new DatabaseSync(":memory:");
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.["user_version"]);
    if (recovery ? version !== 1 : ![4, 5, 6, 7, 8, 9].includes(version)) fail("unsupported_database", "Unsupported database version.");
    initialize(expected, recovery, version);
    if (db.prepare("PRAGMA application_id").get()?.["application_id"] !== (recovery ? 1397446994 : 1397446988)
      || db.prepare("PRAGMA user_version").get()?.["user_version"] !== (recovery ? 1 : version)
      || schema(db) !== schema(expected)) fail("unsupported_database", "Expected the supported Skilly schema (main v4–v9 / recovery v1), without custom SQL objects.");
    if (db.prepare("PRAGMA integrity_check").all().some(row => row["integrity_check"] !== "ok")
      || db.prepare("PRAGMA foreign_key_check").all().length) fail("invalid_database", "Database integrity or foreign keys failed.");
    if (!recovery && version >= 5) validateSkillData(db);
    if (!recovery && version >= 6) validateExecutionData(db);
  } finally { expected.close(); }
}
export function readDatabase(path: string, recovery = false): DatabaseSync {
  closeSync(fileDescriptor(path));
  const db = new DatabaseSync(path, { readOnly: true, enableDoubleQuotedStringLiterals: false });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; PRAGMA cache_size = -2048; BEGIN;");
    // Pin the read view before checking/copying tables. Neither migrations nor a writer is opened.
    db.prepare("SELECT count(*) FROM sqlite_schema").get();
    validateDatabase(db, recovery);
    return db;
  } catch (error) { db.close(); throw error; }
}
