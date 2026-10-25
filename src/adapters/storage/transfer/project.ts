import { validatePlanData } from "../sqlite/plans.js";
import { validateDecisionData } from "../sqlite/decisions.js";
import { validateSkillData } from "../sqlite/skills.js";
import { validateExecutionData } from "../sqlite/executions.js";
import { validateFeatureDiscoveryData } from "../sqlite/feature-discovery.js";
import { normalizeCodePath } from "../../../core/work/discovery.js";
import { lstatSync, readFileSync } from "node:fs";
import { closeSync, fsyncSync, writeSync } from "node:fs";
import { z } from "zod";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { MAX_DATA_BYTES, MAX_LINE_BYTES, MAX_ROWS, rowSchemas, tables, type Manifest, type Table } from "../../../core/transfer/format.js";
import { validateRecoveryPair, validateRecoveryRow } from "./recovery.js";
import { bundleLines, checkFile, digest, fail, fileDescriptor, newDirectory, writeNew } from "./files.js";
import { initialize, readDatabase, validateDatabase } from "./database.js";
import { copyDatabase, openSnapshots } from "./snapshot.js";
import { readManifest } from "./files.js";
import { openSync, constants } from "node:fs";
import { exportProjectEvents, importProjectEvents, scanProjectEvents, type SourceRecords } from "./project-events.js";
import { lifecycleSchemaSql } from "../sqlite/lifecycle.js";
import { taskLinkSchema } from "../sqlite/task-event-storage.js";
import { eventImportSchemaSql } from "../sqlite/event-imports.js";
import { readEvents, validateEventPair, validateEventStore } from "./events.js";
import { putAuthority, readAuthority, hasAuthority, authoritySql, type AuthorityRow } from "../sqlite/project-authority.js";

type Row = Record<string, SQLOutputValue>;
function columns(table: Table): string[] { return Object.keys(rowSchemas[table].shape); }
function select(table: Table, sourceSequences = false): string {
  const fields = columns(table).map(name => `t."${name}"`).join(",") + (table === "records" && sourceSequences ? ",t.seq AS source_seq" : "");
  const where = table === "run_actors" ? "t.run_id IN (SELECT id FROM runs WHERE project_id = ?)"
    : table === "receipts" ? "(t.scope = ?1 OR (t.scope = 'registration' AND json_extract(t.result_json, '$.project.id') = ?1))"
    : table === "projects" ? "t.id = ?" : "t.project_id = ?";
  return `SELECT ${fields} FROM ${table} t WHERE ${where} ORDER BY ${(table === "records" || table === "skill_observations" || table === "plan_item_updates") ? "t.seq" : table === "skill_versions" ? "t.rowid" : columns(table).map(name => `t."${name}"`).join(",")}`;
}
function parsedRow(table: Table, value: unknown, projectId: string, runs: Set<string>, sourceSequences = false): Row {
  const schema = table === "records" && sourceSequences ? rowSchemas.records.extend({ source_seq: z.int().positive() }) : rowSchemas[table];
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("invalid_bundle", `Invalid ${table} row; no input SQL is executed.`);
  const row: Row = parsed.data;
  if(table==="feature_code_paths" && normalizeCodePath(String(row["path"]))!==row["path"]) fail("invalid_bundle","Code path must already be normalized.");
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
  const snapshots = openSnapshots(path, true);
  try {
    const project = snapshots.main.prepare("SELECT project_key FROM projects WHERE id = ?").get(projectId);
    if (!project) fail("not_found", "Project ID not found in this DB.");
    newDirectory(output);
    const fd = openSync(join(output, "data.ndjson"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let bytes = 0, count = 0;
    const runs = new Set<string>();
    try {
      for (const table of tables) {
        if (table === "storage_origins" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 16) continue;
        if (table === "task_skill_usage" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 15) continue;
        if (table === "decision_events" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 13) continue;
        if (table === "execution_worktrees" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 12) continue;
        if (table.startsWith("plan_") && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 11) continue;
        if ((table === "feature_aliases" || table === "feature_code_paths") && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 10) continue;
        if (table === "run_acknowledgements" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 9) continue;
        if (table === "execution_test_details" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 7) continue;
        if (table === "execution_sources" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 8) continue;
        if (table === "executions" && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 6) continue;
        if (table.startsWith("skill_") && Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) < 5) continue;
        const db = table === "requests" ? snapshots.recovery : snapshots.main;
        if (!db) continue;
        for (const raw of db.prepare(select(table, Boolean(snapshots.events))).iterate(projectId)) {
          const row = parsedRow(table, raw, projectId, runs, Boolean(snapshots.events));
          const line = JSON.stringify({ table, row }) + "\n", size = Buffer.byteLength(line);
          if (size > MAX_LINE_BYTES || bytes + size > MAX_DATA_BYTES || count + 1 > MAX_ROWS) fail("transfer_limit", "Project exceeds the v1 transfer limit; no completed bundle was published.");
          const buffer = Buffer.from(line);
          for (let offset = 0; offset < buffer.length;) offset += writeSync(fd, buffer, offset);
          bytes += size; count++;
        }
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const eventData = snapshots.events ? exportProjectEvents(snapshots.events, projectId, String(project["project_key"]), output, bytes, count) : undefined;
    const manifest: Manifest = { format: "skilly-local-transfer", version: eventData ? 3 : 1, kind: "project", schema_version: Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) as Manifest["schema_version"],
      created_at: new Date().toISOString(), main_snapshot_at: snapshots.mainAt, recovery_snapshot_at: snapshots.recoveryAt,
      project_id: projectId, rows: count, files: { main: digest(join(output, "data.ndjson")), recovery: null,
        ...(eventData ? { events: eventData.descriptor } : {}) },
      ...(eventData ? { event_rows: eventData.rows, events_snapshot_at: snapshots.eventsAt! } : {}),
      ...(readAuthority(snapshots.main,projectId)["managed"] ? {requires_activation:true as const} : {}) };
    writeNew(join(output, "manifest.json"), JSON.stringify(manifest));
    return { status: "completed", directory: output, project_id: projectId, rows: count, events: eventData ? "included" : "absent",
      event_rows: eventData?.rows ?? 0, automatic_replay: false, transfer: "copy_not_cutover", atomic_cross_database_snapshot: false };
  } finally { snapshots.close(); }
}
function scan(fd: number, manifest: Manifest, visit: (table: Table, row: Row) => void): void {
  const runs = new Set<string>();
  let count = 0, projects = 0, lastTable = -1;
  if (!manifest.project_id || manifest.rows === null || manifest.files.recovery !== null) fail("invalid_bundle", "Invalid project manifest.");
  for (const line of bundleLines(fd)) {
    let entry: unknown; try { entry = JSON.parse(line); } catch { fail("invalid_bundle", "Invalid NDJSON."); }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join() !== "row,table"
      || !("table" in entry) || typeof entry.table !== "string" || !tables.includes(entry.table as Table) || !("row" in entry)) fail("invalid_bundle", "Unknown table or entry.");
    const table = entry.table as Table, index = tables.indexOf(table);
    if (manifest.schema_version < 16 && table === "storage_origins") fail("invalid_bundle","Storage origins require v16.");
    if (manifest.schema_version < 15 && table === "task_skill_usage") fail("invalid_bundle","Task skill usage requires schema v15.");
    if (manifest.schema_version < 13 && table === "decision_events") fail("invalid_bundle","Decision data requires schema v13.");
    if (index < lastTable || ++count > MAX_ROWS) fail("invalid_bundle", "Invalid row order/count.");
    lastTable = index;
    if (manifest.schema_version < 10 && (table === "feature_aliases" || table === "feature_code_paths")) fail("invalid_bundle", "Feature discovery requires schema v10.");
    if (manifest.schema_version < 9 && table === "run_acknowledgements") fail("invalid_bundle", "Run acknowledgements require schema v9.");
    if (manifest.schema_version < 5 && table.startsWith("skill_")) fail("invalid_bundle", "Skill rows require schema v5.");
    if (manifest.schema_version < 7 && table === "execution_test_details") fail("invalid_bundle", "Test details require schema v7.");
    if (manifest.schema_version < 8 && table === "execution_sources") fail("invalid_bundle", "Execution source observations require schema v8.");
    if (manifest.schema_version < 6 && table === "executions") fail("invalid_bundle", "Execution rows require schema v6.");
    if (manifest.schema_version < 12 && table === "execution_worktrees") fail("invalid_bundle", "Worktree fingerprints require schema v12.");
    if (manifest.schema_version < 11 && table.startsWith("plan_")) fail("invalid_bundle", "Plan data requires schema v11.");
    const row = parsedRow(table, entry.row, manifest.project_id, runs, manifest.version === 3);
    if (table === "projects") projects++;
    visit(table, row);
  }
  if (projects !== 1 || count !== manifest.rows) fail("invalid_bundle", "Project or row count mismatch.");
}
export async function importProject(input: string, output: string, base?: string, quarantine?: AuthorityRow) {
  const manifest = readManifest(input, "project"), data = join(input, "data.ndjson");
  if(manifest.requires_activation && !quarantine)fail("activation_required","A managed project requires the transfer workflow; a copy must not inherit write authority.");
  if (quarantine && (base || quarantine.project_id!==manifest.project_id || quarantine.state!=="blocked")) fail("invalid_input","Quarantine requires a fresh single-project blocked copy.");
  rejectProjectCompanions(input, manifest.version === 3);
  if (manifest.files.main.bytes > MAX_DATA_BYTES) fail("transfer_limit", "Bundle exceeds the import limit.");
  checkFile(data, manifest.files.main);
  const fd = fileDescriptor(data, MAX_DATA_BYTES);
  let eventFd: number | undefined;
  const sourceRecords: SourceRecords = new Map(), sourceRuns = new Set<string>(); let projectKey = "";
  try {
    scan(fd, manifest, (table, row) => {
      if (table === "projects") projectKey = String(row["project_key"]);
      if (table === "runs") sourceRuns.add(String(row["id"]));
      if (table === "records" && manifest.version === 3) sourceRecords.set(String(row["id"]), { seq: Number(row["source_seq"]), run: String(row["run_id"]), recordedAt: String(row["recorded_at"]) });
    });
    const eventScope = { id: manifest.project_id!, key: projectKey, runs: sourceRuns, records: sourceRecords };
    if (quarantine && quarantine.project_key!==projectKey) fail("scope_mismatch","Quarantine project differs.");
    if (manifest.version === 3) {
      checkFile(join(input, "events.ndjson"), manifest.files.events!);
      eventFd = fileDescriptor(join(input, "events.ndjson"), MAX_DATA_BYTES);
      scanProjectEvents(eventFd, manifest, eventScope, () => {});
    }
    if (base) await copyDatabase(base, output);
    else newDirectory(output);
    const mainPath = join(output, "memory.sqlite"), journalPath = `${mainPath}.recovery.sqlite`;
    if (!base) writeNew(mainPath, "");
    const main = new DatabaseSync(mainPath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    let journal: DatabaseSync | undefined;
    let events: DatabaseSync | undefined;
    try {
      if (!base) initialize(main,false,manifest.schema_version===16?16:15);
      else if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 4) main.exec(readFileSync(new URL("../../../../migrations/005-skill-library.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 5) main.exec(readFileSync(new URL("../../../../migrations/006-executions.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 6) main.exec(readFileSync(new URL("../../../../migrations/007-test-details.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 7) main.exec(readFileSync(new URL("../../../../migrations/008-execution-source.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 8) main.exec(readFileSync(new URL("../../../../migrations/009-run-acknowledgements.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 9) main.exec(readFileSync(new URL("../../../../migrations/010-feature-discovery.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 10) main.exec(readFileSync(new URL("../../../../migrations/011-plans.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 11) main.exec(readFileSync(new URL("../../../../migrations/012-execution-worktrees.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 12) main.exec(readFileSync(new URL("../../../../migrations/013-decisions.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 13) main.exec(readFileSync(new URL("../../../../migrations/014-decision-guards.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 14) main.exec(readFileSync(new URL("../../../../migrations/015-task-skill-usage.sql", import.meta.url), "utf8"));
      if (manifest.schema_version === 16 && Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 15) main.exec(readFileSync(new URL("../../../../migrations/016-storage-origins.sql", import.meta.url), "utf8"));
      if (Number(main.prepare("PRAGMA user_version").get()?.["user_version"]) === 16 && hasAuthority(main)) main.exec(authoritySql("main",true,true));
      // Initialize a companion only in the new, private output directory.
      try { writeNew(journalPath, ""); journal = new DatabaseSync(journalPath); initialize(journal, true); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        journal = new DatabaseSync(journalPath);
      }
      if (eventFd !== undefined) {
        const eventPath = `${mainPath}.events.sqlite`;
        try { writeNew(eventPath, ""); events = new DatabaseSync(eventPath); events.exec(lifecycleSchemaSql); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; events = new DatabaseSync(eventPath); }
        events.exec(taskLinkSchema + eventImportSchemaSql + "PRAGMA user_version=2;");
      }
      main.exec("PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON;");
      journal.exec("BEGIN IMMEDIATE;");
      events?.exec("BEGIN IMMEDIATE;");
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
        validateFeatureDiscoveryData(main);
        validatePlanData(main);
        validateDecisionData(main);
        if (events && eventFd !== undefined) {
          importProjectEvents(eventFd, manifest, eventScope, main, events);
          validateEventStore(events); validateEventPair(main, events);
          checkFile(join(input, "events.ndjson"), manifest.files.events!);
        }
        checkFile(data, manifest.files.main);
        rejectProjectCompanions(input, manifest.version === 3);
        if(quarantine) {
          putAuthority(main,"main",quarantine); putAuthority(journal,"recovery",quarantine);
          if(events)putAuthority(events,"events",quarantine);
        }
        main.exec("COMMIT"); journal.exec("COMMIT"); events?.exec("COMMIT");
      } catch (error) {
        if (main.isTransaction) main.exec("ROLLBACK");
        if (journal.isTransaction) journal.exec("ROLLBACK");
        if (events?.isTransaction) events.exec("ROLLBACK");
        if (error instanceof Error && "errcode" in error && typeof error.errcode === "number" && (error.errcode & 255) === 19) {
          fail("import_conflict", "Import has conflicting identities, keys or references. The original DB is unchanged; the new output has no completion marker.");
        }
        throw error;
      }
      validateDatabase(main); validateDatabase(journal, true);
    } finally { main.close(); journal?.close(); events?.close(); }
    const checked = readDatabase(mainPath);
    try {
      if (manifest.version === 3) {
        const eventCheck = readEvents(`${mainPath}.events.sqlite`);
        try { validateEventPair(checked, eventCheck); } finally { eventCheck.close(); }
        checkFile(join(input, "events.ndjson"), manifest.files.events!);
      }
      checkFile(data, manifest.files.main);
      rejectProjectCompanions(input, manifest.version === 3);
    } finally { checked.close(); }
    writeNew(join(output, "import.json"), JSON.stringify({ format: "skilly-project-import", version: 1, project_id: manifest.project_id,
      source_sha256: manifest.files.main.sha256, ...(manifest.files.events ? { source_events_sha256: manifest.files.events.sha256 } : {}),
      created_at: new Date().toISOString(), automatic_replay: false }));
    return { status: "completed", directory: output, db: mainPath, project_id: manifest.project_id, rows: manifest.rows,
      events: manifest.version === 3 ? "imported_history" : "not_in_bundle", event_rows: manifest.event_rows ?? 0,
      transfer: "copy_not_cutover", automatic_replay: false };
  } finally { closeSync(fd); if (eventFd !== undefined) closeSync(eventFd); }
}

function rejectProjectCompanions(input: string, declaredEvents: boolean): void {
  const names = ["memory.sqlite.events.sqlite", ...(!declaredEvents ? ["events.ndjson"] : [])];
  for (const name of ["events.ndjson", "memory.sqlite.events.sqlite"]) for (const suffix of ["-wal", "-shm", "-journal"]) names.push(name + suffix);
  for (const name of names) {
    try { lstatSync(join(input, name)); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    fail("unsealed_bundle", "Undeclared event companion or overlay; existing files preserved.");
  }
}
