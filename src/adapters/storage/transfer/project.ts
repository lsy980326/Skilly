import { validateSkillData } from "../sqlite/skills.js";
import { validateExecutionData } from "../sqlite/executions.js";
import { readFileSync } from "node:fs";
import { closeSync, fsyncSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { MAX_DATA_BYTES, MAX_LINE_BYTES, MAX_ROWS, rowSchemas, tables, type Manifest, type Table } from "../../../core/transfer/format.js";
import { validateRecoveryPair, validateRecoveryRow } from "./recovery.js";
import { checkFile, digest, fail, fileDescriptor, newDirectory, writeNew } from "./files.js";
import { initialize, readDatabase, validateDatabase } from "./database.js";
import { copyDatabase, openSnapshots } from "./snapshot.js";
import { readManifest } from "./files.js";
import { openSync, constants } from "node:fs";

type Row = Record<string, SQLOutputValue>;
function columns(table: Table): string[] { return Object.keys(rowSchemas[table].shape); }
function select(table: Table): string {
  const fields = columns(table).map(name => `t."${name}"`).join(",");
  const where = table === "run_actors" ? "t.run_id IN (SELECT id FROM runs WHERE project_id = ?)"
    : table === "receipts" ? "(t.scope = ?1 OR (t.scope = 'registration' AND json_extract(t.result_json, '$.project.id') = ?1))"
    : table === "projects" ? "t.id = ?" : "t.project_id = ?";
  return `SELECT ${fields} FROM ${table} t WHERE ${where} ORDER BY ${(table === "records" || table === "skill_observations") ? "t.seq" : table === "skill_versions" ? "t.rowid" : columns(table).map(name => `t."${name}"`).join(",")}`;
}
function parsedRow(table: Table, value: unknown, projectId: string, runs: Set<string>): Row {
  const parsed = rowSchemas[table].safeParse(value);
  if (!parsed.success) fail("invalid_bundle", `Invalid ${table} row; no input SQL is executed.`);
  const row: Row = parsed.data;
  if (table === "projects" ? row["id"] !== projectId : "project_id" in row && row["project_id"] !== projectId) {
    fail("scope_mismatch", "Bundle contains another project's row.");
  }
  if (table === "runs") runs.add(String(row["id"]));
  if (table === "run_actors" && !runs.has(String(row["run_id"]))) fail("scope_mismatch", "Actor belongs to a foreign run.");
  if (table === "receipts") {
    let result; try { result = JSON.parse(String(row["result_json"])); } catch { fail("invalid_bundle", "Invalid receipt JSON."); }
    if (row["scope"] !== projectId && !(row["scope"] === "registration" && result?.project?.id === projectId)) {
      fail("scope_mismatch", "Receipt belongs to another project.");
    }
  }
  if (table === "record_reports") {
    try { const report: unknown = JSON.parse(String(row["report_json"])); if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error(); }
    catch { fail("invalid_bundle", "Invalid report JSON."); }
  }
  if (table === "requests") validateRecoveryRow(row);

  return row;
}
export function exportProject(path: string, projectId: string, output: string) {
  const snapshots = openSnapshots(path);
  try {
    if (!snapshots.main.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)) fail("not_found", "Project ID not found in this DB.");
    newDirectory(output);
    const fd = openSync(join(output, "data.ndjson"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let bytes = 0, count = 0;
    const runs = new Set<string>();
    try {
      for (const table of tables) {
        if (table === "run_acknowledgements" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 9) continue;
        if (table === "execution_test_details" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 7) continue;
        if (table === "execution_sources" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 8) continue;
        if (table === "executions" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 6) continue;
        if (table.startsWith("skill_") && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 5) continue;
        const db = table === "requests" ? snapshots.recovery : snapshots.main;
        if (!db) continue;
        for (const raw of db.prepare(select(table)).iterate(projectId)) {
          const row = parsedRow(table, raw, projectId, runs);
          const line = JSON.stringify({ table, row }) + "\n", size = Buffer.byteLength(line);
          if (size > MAX_LINE_BYTES || bytes + size > MAX_DATA_BYTES || count + 1 > MAX_ROWS) fail("transfer_limit", "Project exceeds the v1 transfer limit; no completed bundle was published.");
          const buffer = Buffer.from(line);
          for (let offset = 0; offset < buffer.length;) offset += writeSync(fd, buffer, offset);
          bytes += size; count++;
        }
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const manifest: Manifest = { format: "skilly-local-transfer", version: 1, kind: "project", schema_version: Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) as Manifest["schema_version"],
      created_at: new Date().toISOString(), main_snapshot_at: snapshots.mainAt, recovery_snapshot_at: snapshots.recoveryAt,
      project_id: projectId, rows: count, files: { main: digest(join(output, "data.ndjson")), recovery: null } };
    writeNew(join(output, "manifest.json"), JSON.stringify(manifest));
    return { status: "completed", directory: output, project_id: projectId, rows: count, automatic_replay: false, transfer: "copy_not_cutover" };
  } finally { snapshots.close(); }
}
function* lines(fd: number): Generator<string> {
  const buffer = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0), count, offset = 0;
  while ((count = readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
    offset += count; pending = Buffer.concat([pending, buffer.subarray(0, count)]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end + 1 > MAX_LINE_BYTES) fail("transfer_limit", "Oversized bundle row.");
      const line = pending.subarray(0, end);
      // Reject broken UTF-8 instead of silently replacing the original record text.
      yield new TextDecoder("utf-8", { fatal: true }).decode(line);
      pending = pending.subarray(end + 1);
    }
    if (pending.length > MAX_LINE_BYTES || offset > MAX_DATA_BYTES) fail("transfer_limit", "Oversized bundle data.");
  }
  if (pending.length) fail("invalid_bundle", "Incomplete NDJSON row.");
}
function scan(fd: number, manifest: Manifest, visit: (table: Table, row: Row) => void): void {
  const runs = new Set<string>();
  let count = 0, projects = 0, lastTable = -1;
  if (!manifest.project_id || manifest.rows === null || manifest.files.recovery !== null) fail("invalid_bundle", "Invalid project manifest.");
  for (const line of lines(fd)) {
    let entry: unknown; try { entry = JSON.parse(line); } catch { fail("invalid_bundle", "Invalid NDJSON."); }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join() !== "row,table"
      || !("table" in entry) || typeof entry.table !== "string" || !tables.includes(entry.table as Table) || !("row" in entry)) fail("invalid_bundle", "Unknown table or entry.");
    const table = entry.table as Table, index = tables.indexOf(table);
    if (index < lastTable || ++count > MAX_ROWS) fail("invalid_bundle", "Invalid row order/count.");
    lastTable = index;
    if (manifest.schema_version < 9 && table === "run_acknowledgements") fail("invalid_bundle", "Run acknowledgements require schema v9.");
    if (manifest.schema_version < 5 && table.startsWith("skill_")) fail("invalid_bundle", "Skill rows require schema v5.");
    if (manifest.schema_version < 7 && table === "execution_test_details") fail("invalid_bundle", "Test details require schema v7.");
    if (manifest.schema_version < 8 && table === "execution_sources") fail("invalid_bundle", "Execution source observations require schema v8.");
    if (manifest.schema_version < 6 && table === "executions") fail("invalid_bundle", "Execution rows require schema v6.");
    const row = parsedRow(table, entry.row, manifest.project_id, runs);
    if (table === "projects") projects++;
    visit(table, row);
  }
  if (projects !== 1 || count !== manifest.rows) fail("invalid_bundle", "Project or row count mismatch.");
}
export async function importProject(input: string, output: string, base?: string) {
  const manifest = readManifest(input, "project"), data = join(input, "data.ndjson");
  if (manifest.files.main.bytes > MAX_DATA_BYTES) fail("transfer_limit", "Bundle exceeds the import limit.");
  checkFile(data, manifest.files.main);
  const fd = fileDescriptor(data, MAX_DATA_BYTES);
  try {
    scan(fd, manifest, () => {}); // Reject unknown fields/tables and scope leaks before creating any destination.
    if (base) await copyDatabase(base, output);
    else newDirectory(output);
    const mainPath = join(output, "memory.sqlite"), journalPath = `${mainPath}.recovery.sqlite`;
    if (!base) writeNew(mainPath, "");
    const main = new DatabaseSync(mainPath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    let journal: DatabaseSync | undefined;
    try {
      if (!base) initialize(main);
      else if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 4) main.exec(readFileSync(new URL("../../../../migrations/005-skill-library.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 5) main.exec(readFileSync(new URL("../../../../migrations/006-executions.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 6) main.exec(readFileSync(new URL("../../../../migrations/007-test-details.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 7) main.exec(readFileSync(new URL("../../../../migrations/008-execution-source.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 8) main.exec(readFileSync(new URL("../../../../migrations/009-run-acknowledgements.sql", import.meta.url), "utf8"));
      // Initialize a companion only in the new, private output directory.
      try { writeNew(journalPath, ""); journal = new DatabaseSync(journalPath); initialize(journal, true); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        journal = new DatabaseSync(journalPath);
      }
      main.exec("PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON;");
      journal.exec("BEGIN IMMEDIATE;");
      try {
        scan(fd, manifest, (table, row) => {
          const target = table === "requests" ? journal : main;
          if (!target) throw new Error("Missing journal");
          const names = columns(table);
          target.prepare(`INSERT INTO ${table} (${names.map(name => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`)
            .run(...names.map(name => row[name] as SQLInputValue));
        });
        if (main.prepare("PRAGMA foreign_key_check").all().length) fail("scope_mismatch", "Imported references are incomplete or foreign.");
        validateRecoveryPair(main, journal);
        validateSkillData(main);
        validateExecutionData(main);
        checkFile(data, manifest.files.main);
        main.exec("COMMIT"); journal.exec("COMMIT");
      } catch (error) {
        if (main.isTransaction) main.exec("ROLLBACK");
        if (journal.isTransaction) journal.exec("ROLLBACK");
        if (error instanceof Error && "errcode" in error && typeof error.errcode === "number" && (error.errcode & 255) === 19) {
          fail("import_conflict", "Import has conflicting identities, keys or references. The original DB is unchanged; the new output has no completion marker.");
        }
        throw error;
      }
      validateDatabase(main); validateDatabase(journal, true);
    } finally { main.close(); journal?.close(); }
    const checked = readDatabase(mainPath); checked.close();
    writeNew(join(output, "import.json"), JSON.stringify({ format: "skilly-project-import", version: 1, project_id: manifest.project_id,
      source_sha256: manifest.files.main.sha256, created_at: new Date().toISOString(), automatic_replay: false }));
    return { status: "completed", directory: output, db: mainPath, project_id: manifest.project_id, rows: manifest.rows,
      transfer: "copy_not_cutover", automatic_replay: false };
  } finally { closeSync(fd); }
}
